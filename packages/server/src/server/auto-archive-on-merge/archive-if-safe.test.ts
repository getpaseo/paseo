import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  archiveIfSafe,
  type ArchiveIfSafeDependencies,
  type AutoArchiveArchiveOptions,
} from "./archive-if-safe.js";
import type { ArchiveResult, ActiveWorkspaceRef } from "../workspace-archive-service.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import { createWorktree, type WorktreeConfig } from "../../utils/worktree.js";
import type { ForgeService } from "../../../services/forge-service.js";
import type { StoredAgentRecord } from "../agent/agent-storage.js";

const CWD = "/tmp/paseo/worktrees/repo/branch";
const PASEO_HOME = "/tmp/paseo";
const WORKTREES_ROOT = "/tmp/paseo/worktrees/repo";

function createPullRequest(
  overrides?: Partial<NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]>>,
): NonNullable<WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"]> {
  return {
    url: "https://github.com/acme/repo/pull/123",
    title: "Merge me",
    state: "open",
    baseRefName: "main",
    headRefName: "feature",
    isMerged: true,
    ...overrides,
  };
}

function createSnapshot(overrides?: {
  git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
  pullRequest?: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
}): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: CWD,
    git: {
      isGit: true,
      repoRoot: "/tmp/repo",
      mainRepoRoot: "/tmp/repo",
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      isPaseoOwnedWorktree: true,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 0, deletions: 0 },
      ...overrides?.git,
    },
    github: {
      featuresEnabled: true,
      pullRequest:
        overrides && "pullRequest" in overrides
          ? (overrides.pullRequest ?? null)
          : createPullRequest(),
      error: null,
    },
  };
}

function createLogger(): Logger {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as Logger;
}

function createHarness(overrides?: {
  autoArchiveAfterMerge?: boolean;
  getSnapshot?: () => Promise<WorkspaceGitRuntimeSnapshot | null>;
  isPaseoOwnedWorktreeCwd?: ArchiveIfSafeDependencies["isPaseoOwnedWorktreeCwd"];
  archiveByScope?: ArchiveIfSafeDependencies["archiveByScope"];
  resolveWorkspaceIdAtPath?: ArchiveIfSafeDependencies["resolveWorkspaceIdAtPath"];
}) {
  const getConfig = vi.fn(() => ({
    autoArchiveAfterMerge: overrides?.autoArchiveAfterMerge ?? true,
  }));
  const getSnapshot = vi.fn(
    overrides?.getSnapshot ?? (async () => createSnapshot()),
  ) as unknown as AutoArchiveArchiveOptions["workspaceGitService"]["getSnapshot"];
  const workspaceGitService = {
    getSnapshot,
  } as unknown as AutoArchiveArchiveOptions["workspaceGitService"];
  const options: AutoArchiveArchiveOptions = {
    paseoHome: PASEO_HOME,
    daemonConfigStore: {
      get: getConfig,
    } as unknown as AutoArchiveArchiveOptions["daemonConfigStore"],
    workspaceGitService,
    github: {} as AutoArchiveArchiveOptions["github"],
    agentManager: {} as AutoArchiveArchiveOptions["agentManager"],
    agentStorage: {} as AutoArchiveArchiveOptions["agentStorage"],
    terminalManager: {} as AutoArchiveArchiveOptions["terminalManager"],
    findWorkspaceIdForCwd: vi.fn(async () => "ws-auto-archive"),
    listActiveWorkspaces: vi.fn(async () => []),
    archiveWorkspaceRecord: vi.fn(),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(),
  };
  const archiveByScope = vi.fn(
    overrides?.archiveByScope ??
      (async () =>
        ({
          archivedAgentIds: [],
          archivedWorkspaceIds: [],
          removedDirectory: false,
        }) satisfies ArchiveResult),
  ) as unknown as ArchiveIfSafeDependencies["archiveByScope"];
  const resolveWorkspaceIdAtPath = vi.fn(
    overrides?.resolveWorkspaceIdAtPath ?? (async () => "ws-auto-archive"),
  ) as unknown as ArchiveIfSafeDependencies["resolveWorkspaceIdAtPath"];
  const isPaseoOwnedWorktreeCwd = vi.fn(
    overrides?.isPaseoOwnedWorktreeCwd ??
      (async () => ({
        allowed: true,
        repoRoot: "/tmp/repo",
        worktreeRoot: WORKTREES_ROOT,
        worktreePath: CWD,
      })),
  ) as unknown as ArchiveIfSafeDependencies["isPaseoOwnedWorktreeCwd"];
  const deps: ArchiveIfSafeDependencies = {
    archiveByScope,
    resolveWorkspaceIdAtPath,
    isPaseoOwnedWorktreeCwd,
    killTerminalsForWorkspace: vi.fn(),
  };
  const log = createLogger();
  const inFlight = new Set<string>();

  return {
    deps,
    getConfig,
    getSnapshot,
    inFlight,
    log,
    options,
  };
}

async function runArchiveIfSafe(
  harness: ReturnType<typeof createHarness>,
  overrides?: {
    cwd?: string;
    pullRequest?: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
  },
): Promise<void> {
  await archiveIfSafe({
    cwd: overrides?.cwd ?? CWD,
    pullRequest:
      overrides && "pullRequest" in overrides
        ? (overrides.pullRequest ?? null)
        : createPullRequest(),
    inFlight: harness.inFlight,
    options: harness.options,
    log: harness.log,
    deps: harness.deps,
  });
}

const cleanupPaths: string[] = [];

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "archive-if-safe-"));
  cleanupPaths.push(tempDir);
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { tempDir, repoDir };
}

async function createPaseoOwnedWorktree(
  repoDir: string,
  paseoHome: string,
  worktreeSlug: string,
): Promise<WorktreeConfig> {
  return createWorktree({
    cwd: repoDir,
    worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: "main",
      branchName: worktreeSlug,
    },
    runSetup: false,
    paseoHome,
  });
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    }),
    getPullRequest: async ({ number }) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      labels: [],
    }),
    getPullRequestHeadRef: async ({ number }) => `pr-${number}`,
    getPullRequestCheckoutTarget: async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: `pr-${number}`,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    }),
    getCurrentPullRequestStatus: async () => null,
    createPullRequest: async () => ({
      number: 1,
      url: "https://github.com/acme/repo/pull/1",
    }),
    mergePullRequest: async () => ({ success: true }),
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createRealOutcomeHarness(input: {
  paseoHome: string;
  repoDir: string;
  worktreePath: string;
  activeWorkspaces: ActiveWorkspaceRef[];
  archivedWorkspaceIds: Set<string>;
}) {
  const active = [...input.activeWorkspaces];
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);

  const options: AutoArchiveArchiveOptions = {
    paseoHome: input.paseoHome,
    daemonConfigStore: {
      get: () => ({ autoArchiveAfterMerge: true }),
    } as unknown as AutoArchiveArchiveOptions["daemonConfigStore"],
    workspaceGitService: {
      getSnapshot: async () =>
        ({
          cwd: input.worktreePath,
          git: {
            isGit: true,
            repoRoot: input.repoDir,
            mainRepoRoot: input.repoDir,
            currentBranch: "feature",
            remoteUrl: "https://github.com/acme/repo.git",
            isPaseoOwnedWorktree: true,
            isDirty: false,
            baseRef: "main",
            aheadBehind: { ahead: 0, behind: 0 },
            aheadOfOrigin: 0,
            behindOfOrigin: 0,
            hasRemote: true,
            diffStat: { additions: 0, deletions: 0 },
          },
          github: {
            featuresEnabled: true,
            pullRequest: createPullRequest({ isMerged: true }),
            error: null,
          },
        }) satisfies WorkspaceGitRuntimeSnapshot,
    } as unknown as AutoArchiveArchiveOptions["workspaceGitService"],
    github: createGitHubServiceStub(),
    agentManager: {
      listAgents: () => [],
      archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
      archiveSnapshot: vi.fn(async () => {
        throw new Error("not expected without stored agents");
      }),
    } as unknown as AutoArchiveArchiveOptions["agentManager"],
    agentStorage: {
      list: async (): Promise<StoredAgentRecord[]> => [],
    } as unknown as AutoArchiveArchiveOptions["agentStorage"],
    terminalManager: {
      listDirectories: () => [],
      getTerminals: vi.fn().mockResolvedValue([]),
    } as unknown as AutoArchiveArchiveOptions["terminalManager"],
    findWorkspaceIdForCwd: async (cwd: string) => {
      const match = active.find((workspace) => workspace.cwd === cwd);
      return match?.workspaceId ?? null;
    },
    listActiveWorkspaces: async () =>
      active.filter((workspace) => !input.archivedWorkspaceIds.has(workspace.workspaceId)),
    archiveWorkspaceRecord: async (workspaceId: string) => {
      input.archivedWorkspaceIds.add(workspaceId);
      const index = active.findIndex((workspace) => workspace.workspaceId === workspaceId);
      if (index !== -1) {
        active.splice(index, 1);
      }
    },
    markWorkspaceArchiving: () => {},
    clearWorkspaceArchiving: () => {},
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(),
  };

  return {
    options,
    log: logger,
    inFlight: new Set<string>(),
  };
}

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("archiveIfSafe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("does nothing when the pull request is not merged", async () => {
    const harness = createHarness();

    await runArchiveIfSafe(harness, { pullRequest: createPullRequest({ isMerged: false }) });

    expect(harness.getConfig).not.toHaveBeenCalled();
    expect(harness.getSnapshot).not.toHaveBeenCalled();
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
  });

  test("does nothing when auto-archive-after-merge is disabled", async () => {
    const harness = createHarness({ autoArchiveAfterMerge: false });

    await runArchiveIfSafe(harness);

    expect(harness.getConfig).toHaveBeenCalledTimes(1);
    expect(harness.getSnapshot).not.toHaveBeenCalled();
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
  });

  test("does nothing when the cwd already has an archive in flight", async () => {
    const harness = createHarness();
    harness.inFlight.add(CWD);

    await runArchiveIfSafe(harness);

    expect(harness.getSnapshot).not.toHaveBeenCalled();
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
    expect(harness.inFlight.has(CWD)).toBe(true);
  });

  test("logs and skips when reading the snapshot fails", async () => {
    const harness = createHarness({
      getSnapshot: async () => {
        throw new Error("snapshot failed");
      },
    });

    await runArchiveIfSafe(harness);

    expect(harness.log.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), cwd: CWD },
      "Failed to read snapshot for auto-archive; skipping",
    );
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
    expect(harness.inFlight.has(CWD)).toBe(false);
  });

  test("does nothing when there is no snapshot", async () => {
    const harness = createHarness({ getSnapshot: async () => null });

    await runArchiveIfSafe(harness);

    expect(harness.deps.isPaseoOwnedWorktreeCwd).not.toHaveBeenCalled();
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
  });

  test("does nothing when the worktree is dirty", async () => {
    const harness = createHarness({
      getSnapshot: async () => createSnapshot({ git: { isDirty: true } }),
    });

    await runArchiveIfSafe(harness);

    expect(harness.deps.isPaseoOwnedWorktreeCwd).not.toHaveBeenCalled();
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
  });

  test("does nothing when the worktree is ahead of origin", async () => {
    const harness = createHarness({
      getSnapshot: async () => createSnapshot({ git: { aheadOfOrigin: 1 } }),
    });

    await runArchiveIfSafe(harness);

    expect(harness.deps.isPaseoOwnedWorktreeCwd).not.toHaveBeenCalled();
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
  });

  test("archives when the PR is merged and the upstream branch was deleted", async () => {
    const harness = createHarness({
      getSnapshot: async () =>
        createSnapshot({ git: { aheadOfOrigin: null, behindOfOrigin: null } }),
    });

    await runArchiveIfSafe(harness);

    expect(harness.deps.archiveByScope).toHaveBeenCalledTimes(1);
  });

  test("does nothing when the cwd is not a Paseo-owned worktree", async () => {
    const harness = createHarness({
      isPaseoOwnedWorktreeCwd: async () => ({ allowed: false, worktreePath: CWD }),
    });

    await runArchiveIfSafe(harness);

    expect(harness.deps.isPaseoOwnedWorktreeCwd).toHaveBeenCalledWith(CWD, {
      paseoHome: PASEO_HOME,
    });
    expect(harness.deps.archiveByScope).not.toHaveBeenCalled();
  });

  test("logs and does not throw when archiving fails", async () => {
    const harness = createHarness({
      archiveByScope: async () => {
        throw new Error("archive failed");
      },
    });

    await runArchiveIfSafe(harness);

    expect(harness.log.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), cwd: CWD },
      "Auto-archive after merge failed",
    );
    expect(harness.inFlight.has(CWD)).toBe(false);
  });

  test("archives a clean Paseo-owned worktree after merge", async () => {
    const harness = createHarness();

    await runArchiveIfSafe(harness);

    expect(harness.deps.resolveWorkspaceIdAtPath).toHaveBeenCalledTimes(1);
    expect(harness.deps.resolveWorkspaceIdAtPath).toHaveBeenCalledWith(
      {
        findWorkspaceIdForCwd: harness.options.findWorkspaceIdForCwd,
        listActiveWorkspaces: harness.options.listActiveWorkspaces,
      },
      CWD,
    );
    expect(harness.deps.archiveByScope).toHaveBeenCalledTimes(1);
    expect(harness.deps.archiveByScope).toHaveBeenCalledWith(
      expect.objectContaining({
        paseoHome: PASEO_HOME,
        workspaceGitService: harness.options.workspaceGitService,
      }),
      {
        scope: { kind: "workspace", workspaceId: "ws-auto-archive" },
        requestId: "auto-archive-on-merge",
      },
    );
    expect(harness.log.info).toHaveBeenCalledWith(
      { cwd: CWD },
      "Auto-archived worktree after PR merge",
    );
    expect(harness.inFlight.has(CWD)).toBe(false);
  });

  test("resolves the merged cwd to a single workspace and does not iterate siblings", async () => {
    const harness = createHarness({
      resolveWorkspaceIdAtPath: async () => "ws-merged-worktree",
    });
    harness.options.listActiveWorkspaces = vi.fn(async () => [
      { workspaceId: "ws-merged-worktree", cwd: CWD, kind: "worktree" as const },
      { workspaceId: "ws-sibling", cwd: CWD, kind: "local_checkout" as const },
    ]);

    await runArchiveIfSafe(harness);

    expect(harness.deps.resolveWorkspaceIdAtPath).toHaveBeenCalledTimes(1);
    expect(harness.deps.archiveByScope).toHaveBeenCalledTimes(1);
    expect(harness.deps.archiveByScope).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        scope: { kind: "workspace", workspaceId: "ws-merged-worktree" },
      }),
    );
  });

  test("real outcome: keeps sibling workspace and directory on last reference", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "merged-with-sibling");
    const workspaceA = "ws-merged-with-sibling-a";
    const workspaceB = "ws-merged-with-sibling-b";
    const archivedWorkspaceIds = new Set<string>();

    const harness = createRealOutcomeHarness({
      paseoHome,
      repoDir,
      worktreePath: worktree.worktreePath,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "local_checkout" },
      ],
      archivedWorkspaceIds,
    });

    await archiveIfSafe({
      cwd: worktree.worktreePath,
      pullRequest: createPullRequest({ isMerged: true }),
      inFlight: harness.inFlight,
      options: harness.options,
      log: harness.log,
    });

    expect(archivedWorkspaceIds.has(workspaceA)).toBe(true);
    expect(archivedWorkspaceIds.has(workspaceB)).toBe(false);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("real outcome: removes directory when no sibling workspace remains", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "merged-last-ref");
    const workspaceA = "ws-merged-last-ref";
    const archivedWorkspaceIds = new Set<string>();

    const harness = createRealOutcomeHarness({
      paseoHome,
      repoDir,
      worktreePath: worktree.worktreePath,
      activeWorkspaces: [{ workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" }],
      archivedWorkspaceIds,
    });

    await archiveIfSafe({
      cwd: worktree.worktreePath,
      pullRequest: createPullRequest({ isMerged: true }),
      inFlight: harness.inFlight,
      options: harness.options,
      log: harness.log,
    });

    expect(archivedWorkspaceIds.has(workspaceA)).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });
});
