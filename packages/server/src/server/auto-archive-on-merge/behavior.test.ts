import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  setupAutoArchiveOnMerge,
  type AutoArchiveOnMergeDependencies,
  type AutoArchiveOnMergeOptions,
} from "./index.js";
import {
  WorkspaceGitServiceImpl,
  type WorkspaceGitRuntimeSnapshot,
} from "../workspace-git-service.js";
import { createGitHubService } from "../../services/github-service.js";
import { archiveIfSafe } from "./archive-if-safe.js";
import { killTerminalsForWorkspace } from "../workspace-archive-service.js";
import { isPaseoOwnedWorktreeCwd, createWorktree } from "../../utils/worktree.js";

type PullRequestState = "open" | "closed" | "merged";

interface PullRequestObservation {
  url: string;
  headRefName: string;
  state: PullRequestState;
}

const cleanupPaths: string[] = [];
const cleanupServices: WorkspaceGitServiceImpl[] = [];

function run(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function settleObservation(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createWorkspaceFiles() {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "auto-archive-behavior-")));
  cleanupPaths.push(tempDir);
  const repoDir = path.join(tempDir, "repo");
  run(tempDir, ["init", "-b", "main", repoDir]);
  run(repoDir, ["config", "user.email", "test@getpaseo.local"]);
  run(repoDir, ["config", "user.name", "Paseo Test"]);
  writeFileSync(path.join(repoDir, "README.md"), "workspace journey\n");
  run(repoDir, ["add", "README.md"]);
  run(repoDir, ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);

  const paseoHome = path.join(tempDir, ".paseo");
  const worktree = await createWorktree({
    cwd: repoDir,
    worktreeSlug: "workspace",
    source: { kind: "branch-off", baseBranch: "main", branchName: "workspace" },

    paseoHome,
  });
  return { repoDir, paseoHome, worktree };
}

async function createWorkspaceJourney() {
  const { repoDir, worktree } = await createWorkspaceFiles();
  const workspaceId = "workspace-under-test";
  let active = true;
  let currentPullRequest: PullRequestObservation | null = null;
  let listener: ((snapshot: WorkspaceGitRuntimeSnapshot) => void) | null = null;
  let subscription: { unsubscribe: () => void } | null = null;

  function snapshot(): WorkspaceGitRuntimeSnapshot {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: worktree.worktreePath,
      encoding: "utf8",
    }).trim();
    return {
      cwd: worktree.worktreePath,
      git: {
        isGit: true,
        repoRoot: worktree.worktreePath,
        mainRepoRoot: repoDir,
        currentBranch: branch,
        remoteUrl: "https://github.com/acme/repo.git",
        isPaseoOwnedWorktree: true,
        isDirty: false,
        baseRef: "main",
        aheadBehind: { ahead: 0, behind: 0 },
        upstreamRef: `origin/${branch}`,
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
        hasRemote: true,
        diffStat: { additions: 0, deletions: 0 },
      },
      forge: {
        featuresEnabled: true,
        authState: "authenticated",
        pullRequest: currentPullRequest
          ? {
              url: currentPullRequest.url,
              title: currentPullRequest.headRefName,
              state: currentPullRequest.state,
              baseRefName: "main",
              headRefName: currentPullRequest.headRefName,
              isMerged: currentPullRequest.state === "merged",
            }
          : null,
        error: null,
      },
    };
  }

  const options = {
    logger: { child: () => ({ warn: vi.fn() }) } as unknown as Logger,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
    workspaceGitService: {
      onSnapshotUpdated: (nextListener: (next: WorkspaceGitRuntimeSnapshot) => void) => {
        listener = nextListener;
        return {
          unsubscribe: () => {
            if (listener === nextListener) listener = null;
          },
        };
      },
      getSnapshot: async () => snapshot(),
    },
    listActiveWorkspaces: async () =>
      active ? [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" as const }] : [],
  } as unknown as AutoArchiveOnMergeOptions;
  const dependencies: AutoArchiveOnMergeDependencies = {
    archiveIfSafe: async () => {
      active = false;
    },
    resolvePath: path.resolve,
  };

  function startDaemon(): void {
    subscription?.unsubscribe();
    subscription = setupAutoArchiveOnMerge(options, dependencies);
  }

  async function observe(observation: PullRequestObservation | null): Promise<void> {
    currentPullRequest = observation;
    const activeListener = listener;
    if (!activeListener) throw new Error("Daemon is not observing the workspace");
    activeListener(snapshot());
    await settleObservation();
  }

  function checkout(branch: string): void {
    run(worktree.worktreePath, ["checkout", "-B", branch]);
  }

  startDaemon();

  return {
    checkout,
    isActive: () => active,
    observe,
    restartDaemon: startDaemon,
  };
}

async function createUnobservedWorkspace(archiveBarrier?: Promise<void>) {
  const { repoDir, paseoHome, worktree } = await createWorkspaceFiles();
  const cwd = worktree.worktreePath;
  run(repoDir, ["remote", "add", "origin", "https://github.com/acme/repo.git"]);
  run(repoDir, ["update-ref", "refs/remotes/origin/workspace", "HEAD"]);
  run(cwd, ["branch", "--set-upstream-to=origin/workspace"]);
  const logger = pino({ level: "silent" });
  const github = createGitHubService({
    resolveGhPath: async () => "/test/gh",
    runner: async () => ({ stdout: "", stderr: "" }),
  });
  let observation: PullRequestObservation | null = null;
  const reads: Array<string | undefined> = [];
  const archives: string[] = [];
  let active = true;
  const service = new WorkspaceGitServiceImpl({
    logger,
    paseoHome,
    deps: {
      forgeOverrides: { github },
      getPullRequestStatus: async (_cwd, _forge, options) => {
        reads.push(options?.reason);
        return {
          status: observation && {
            ...observation,
            title: observation.headRefName,
            baseRefName: "main",
            isMerged: observation.state === "merged",
          },
          authState: "authenticated",
          featuresEnabled: true,
          githubFeaturesEnabled: true,
        };
      },
    },
  });
  cleanupServices.push(service);
  const options = {
    logger,
    paseoHome,
    daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
    workspaceGitService: service,
    getAutoArchivedChangeRequestUrl: async () => null,
    listActiveWorkspaces: async () =>
      active ? [{ workspaceId: "workspace-under-test", cwd, kind: "worktree" }] : [],
  } as unknown as AutoArchiveOnMergeOptions;
  setupAutoArchiveOnMerge(options, {
    resolvePath: path.resolve,
    archiveIfSafe: async (input) =>
      archiveIfSafe({
        ...input,
        deps: {
          isPaseoOwnedWorktreeCwd,
          killTerminalsForWorkspace,
          archiveByScope: async (_options, request) => {
            if (request.scope.kind !== "workspace") throw new Error("Expected workspace archive");
            archives.push(request.scope.workspaceId);
            await archiveBarrier;
            active = false;
            return {
              archivedAgentIds: [],
              archivedWorkspaceIds: [request.scope.workspaceId],
              removedDirectory: false,
            };
          },
        },
      }),
  });
  return {
    archives,
    reads,
    metrics: () => service.getMetrics(),
    isActive: () => active,
    makeDirty: () => writeFileSync(path.join(cwd, "README.md"), "uncommitted work\n"),
    commitUnpushed: () => {
      writeFileSync(path.join(cwd, "README.md"), "unpushed work\n");
      run(cwd, ["add", "README.md"]);
      run(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", "unpushed"]);
    },
    observe: async (state: PullRequestState) => {
      observation = pullRequest("workspace", state);
      const snapshot = await service.getSnapshot(cwd, { force: true, reason: "workspace-journey" });
      expect(snapshot.forge.pullRequest?.state).toBe(state);
      await settleObservation();
      return snapshot;
    },
  };
}

function pullRequest(
  headRefName: string,
  state: PullRequestState,
  number = 1,
): PullRequestObservation {
  return {
    url: `https://github.com/acme/repo/pull/${number}`,
    headRefName,
    state,
  };
}

afterEach(async () => {
  for (const service of cleanupServices.splice(0)) await service.dispose();
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("workspace auto-archive behavior", () => {
  test("archives a clean owned workspace on an unobserved open-to-merged transition only once", async () => {
    let releaseArchive!: () => void;
    const archiveBarrier = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const workspace = await createUnobservedWorkspace(archiveBarrier);
    try {
      await workspace.observe("open");
      expect(workspace.archives).toEqual([]);

      const merged = await workspace.observe("merged");
      expect(merged.git).toMatchObject({
        isDirty: false,
        aheadOfOrigin: 0,
        isPaseoOwnedWorktree: true,
      });
      await expect.poll(() => workspace.archives).toEqual(["workspace-under-test"]);
      expect(workspace.isActive()).toBe(true);
      await workspace.observe("merged");

      expect(workspace.metrics().workspaceListenerCount).toBe(0);
      expect(workspace.archives).toEqual(["workspace-under-test"]);
      // Confirmation reads the completed snapshot cache; it does not shell out again.
      expect(workspace.reads).toEqual([
        "workspace-journey",
        "workspace-journey",
        "workspace-journey",
      ]);
    } finally {
      releaseArchive();
    }
    await expect.poll(() => workspace.isActive()).toBe(false);
  });

  test("keeps an unobserved workspace active when its first snapshot is already merged", async () => {
    const workspace = await createUnobservedWorkspace();
    await workspace.observe("merged");

    expect(workspace.metrics().workspaceListenerCount).toBe(0);
    expect(workspace.archives).toEqual([]);
    expect(workspace.reads).toEqual(["workspace-journey"]);
  });

  test("keeps dirty work when an unobserved workspace PR merges", async () => {
    const workspace = await createUnobservedWorkspace();
    await workspace.observe("open");
    workspace.makeDirty();
    const merged = await workspace.observe("merged");

    expect(merged.git.isDirty).toBe(true);
    expect(workspace.archives).toEqual([]);
  });

  test("keeps unpushed commits when an unobserved workspace PR merges", async () => {
    const workspace = await createUnobservedWorkspace();
    await workspace.observe("open");
    workspace.commitUnpushed();
    const merged = await workspace.observe("merged");

    expect(merged.git).toMatchObject({ isDirty: false, aheadOfOrigin: 1 });
    expect(workspace.archives).toEqual([]);
  });

  test("archives when the checked-out PR changes from open to merged", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("feature");

    await workspace.observe(pullRequest("feature", "open"));
    expect(workspace.isActive()).toBe(true);

    await workspace.observe(pullRequest("feature", "merged"));
    expect(workspace.isActive()).toBe(false);
  });

  test("archives an existing open PR checked out after workspace creation when it later merges", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("existing-open-pr");

    await workspace.observe(pullRequest("existing-open-pr", "open"));
    expect(workspace.isActive()).toBe(true);

    await workspace.observe(pullRequest("existing-open-pr", "merged"));
    expect(workspace.isActive()).toBe(false);
  });

  test("does not archive when an already-merged PR is checked out", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("already-merged-pr");

    await workspace.observe(pullRequest("already-merged-pr", "merged"));

    expect(workspace.isActive()).toBe(true);
  });

  test("does not archive when an open PR is replaced by a different already-merged PR", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("open-pr");
    await workspace.observe(pullRequest("open-pr", "open", 1));

    workspace.checkout("already-merged-pr");
    await workspace.observe(pullRequest("already-merged-pr", "merged", 2));

    expect(workspace.isActive()).toBe(true);
  });

  test("does not archive after leaving an open PR and later checking it out already merged", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("eventually-merged-pr");
    await workspace.observe(pullRequest("eventually-merged-pr", "open"));

    workspace.checkout("unrelated-work");
    await workspace.observe(null);
    workspace.checkout("eventually-merged-pr");
    await workspace.observe(pullRequest("eventually-merged-pr", "merged"));

    expect(workspace.isActive()).toBe(true);
  });

  test("does not archive when an open PR closes without merging", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("closed-pr");

    await workspace.observe(pullRequest("closed-pr", "open"));
    await workspace.observe(pullRequest("closed-pr", "closed"));

    expect(workspace.isActive()).toBe(true);
  });

  test("does not infer a merge transition from the first observation after daemon restart", async () => {
    const workspace = await createWorkspaceJourney();
    workspace.checkout("merged-while-offline");
    await workspace.observe(pullRequest("merged-while-offline", "open"));

    workspace.restartDaemon();
    await workspace.observe(pullRequest("merged-while-offline", "merged"));

    expect(workspace.isActive()).toBe(true);
  });
});
