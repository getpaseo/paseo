import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import type { GitHubService } from "../services/github-service.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import {
  attemptFirstAgentBranchAutoName,
  createPaseoWorktree,
  type CreatePaseoWorktreeDeps,
} from "./paseo-worktree-service.js";
import { readPaseoWorktreeMetadata } from "../utils/worktree-metadata.js";
import { isPlatform } from "../test-utils/platform.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

test("creates a worktree and registers it in the source workspace project without git snapshot lookup", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const events: string[] = [];
  const deps = createDeps({ events });
  const sourceProject = createPersistedProjectRecordForTest({
    projectId: "remote:github.com/acme/repo",
    rootPath: repoDir,
    displayName: "acme/repo",
  });
  const sourceWorkspace = createPersistedWorkspaceRecordForTest({
    workspaceId: repoDir,
    projectId: sourceProject.projectId,
    cwd: repoDir,
    kind: "local_checkout",
    displayName: "main",
  });
  deps.projects.set(sourceProject.projectId, sourceProject);
  deps.workspaces.set(sourceWorkspace.workspaceId, sourceWorkspace);
  deps.workspaceGitService.getSnapshot = vi.fn(deps.workspaceGitService.getSnapshot);

  const result = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "feature-one",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(result.created).toBe(true);
  expect(result.workspace.cwd).toBe(result.worktree.worktreePath);
  expect(result.workspace.kind).toBe("worktree");
  expect(result.workspace.projectId).toBe("remote:github.com/acme/repo");
  expect(result.workspace.displayName).toBe("feature-one");
  expect(deps.workspaceGitService.getSnapshot).not.toHaveBeenCalled();
  expect(events).toEqual([
    "project:remote:github.com/acme/repo",
    `workspace:${result.workspace.workspaceId}`,
  ]);
});

// POSIX-only: Windows git worktree paths need separate canonicalization coverage.
test.skipIf(isPlatform("win32"))(
  "reuses an existing worktree and still upserts the workspace",
  async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const firstDeps = createDeps();
    const first = await createPaseoWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "reuse-me",
        runSetup: false,
        paseoHome,
      },
      firstDeps,
    );
    const events: string[] = [];
    const deps = createDeps({
      events,
      projects: firstDeps.projects,
      workspaces: firstDeps.workspaces,
    });

    const second = await createPaseoWorktree(
      {
        cwd: repoDir,
        worktreeSlug: "reuse-me",
        runSetup: false,
        paseoHome,
      },
      deps,
    );

    expect(second.created).toBe(false);
    expect(second.worktree.worktreePath).toBe(first.worktree.worktreePath);
    expect(events).toContain(`workspace:${second.workspace.workspaceId}`);
  },
);

test("renames an eligible unnamed branch-off worktree once on first agent context", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(created.worktree.branchName).toBe("dazzling-yak");
  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 2,
    firstAgentBranchAutoName: {
      status: "pending",
      placeholderBranchName: "dazzling-yak",
    },
  });

  const first = await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Build the agent context name" },
    generateBranchNameFromContext: async ({ firstAgentContext }) =>
      firstAgentContext.prompt ? "renamed-from-agent-context" : null,
  });
  const branchAfterFirst = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(first).toEqual({
    attempted: true,
    renamed: true,
    branchName: "renamed-from-agent-context",
  });
  expect(branchAfterFirst).toBe("renamed-from-agent-context");
  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 2,
    firstAgentBranchAutoName: {
      status: "attempted",
      placeholderBranchName: "dazzling-yak",
    },
  });

  const second = await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Try another name" },
    generateBranchNameFromContext: async () => "second-agent-name",
  });
  const branchAfterSecond = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(second).toEqual({ attempted: false, renamed: false, branchName: null });
  expect(branchAfterSecond).toBe("renamed-from-agent-context");
});

test("falls back to a numeric suffix when the desired branch name already exists", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);

  execFileSync("git", ["branch", "renamed-from-agent-context"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "renamed-from-agent-context-2"], { cwd: repoDir, stdio: "pipe" });

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  const result = await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Build the agent context name" },
    generateBranchNameFromContext: async () => "renamed-from-agent-context",
  });

  expect(result).toEqual({
    attempted: true,
    renamed: true,
    branchName: "renamed-from-agent-context-3",
  });
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("renamed-from-agent-context-3");
});

test("renames the branch even when the app supplies a random placeholder slug", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      firstAgentContext: { prompt: "Investigate the failing login flow" },
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(created.worktree.branchName).toBe("dazzling-yak");
  expect(created.workspace.displayName).toBe("dazzling-yak");

  await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: { prompt: "Investigate the failing login flow" },
    generateBranchNameFromContext: async ({ firstAgentContext }) =>
      firstAgentContext.prompt === "Investigate the failing login flow"
        ? "renamed-from-prompt"
        : null,
  });

  const branchAfter = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(branchAfter).toBe("renamed-from-prompt");
});

test("renames the branch from a github_pr attachment when no prompt is supplied", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      firstAgentContext: {
        attachments: [
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 42,
            title: "Investigate flaky checkout test",
            url: "https://github.com/acme/repo/pull/42",
          },
        ],
      },
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    deps,
  );

  expect(created.worktree.branchName).toBe("dazzling-yak");

  await attemptFirstAgentBranchAutoName({
    cwd: created.worktree.worktreePath,
    firstAgentContext: {
      attachments: [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 42,
          title: "Investigate flaky checkout test",
          url: "https://github.com/acme/repo/pull/42",
        },
      ],
    },
    generateBranchNameFromContext: async ({ firstAgentContext }) =>
      firstAgentContext.attachments?.[0]?.type === "github_pr"
        ? "renamed-from-pr-attachment"
        : null,
  });

  const branchAfter = execFileSync("git", ["branch", "--show-current"], {
    cwd: created.worktree.worktreePath,
    stdio: "pipe",
  })
    .toString()
    .trim();

  expect(branchAfter).toBe("renamed-from-pr-attachment");
});

test("leaves the branch alone when generated branch text is invalid", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      worktreeSlug: "dazzling-yak",
      firstAgentContext: { prompt: "Name this branch" },
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  await expect(
    attemptFirstAgentBranchAutoName({
      cwd: created.worktree.worktreePath,
      firstAgentContext: { prompt: "Name this branch" },
      generateBranchNameFromContext: async () => "Invalid Branch Name",
    }),
  ).resolves.toEqual({ attempted: true, renamed: false, branchName: null });

  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("dazzling-yak");
  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 2,
    firstAgentBranchAutoName: {
      status: "attempted",
      placeholderBranchName: "dazzling-yak",
    },
  });
});

test("does not mark checkout branch worktrees as eligible for first-agent rename", async () => {
  const { repoDir, tempDir } = createGitRepo();
  cleanupPaths.push(tempDir);
  execFileSync("git", ["checkout", "-b", "dev"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "dev branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "dev"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      action: "checkout",
      refName: "dev",
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 1,
    baseRefName: "dev",
  });
  await expect(
    attemptFirstAgentBranchAutoName({
      cwd: created.worktree.worktreePath,
      firstAgentContext: { prompt: "Rename checkout branch" },
      generateBranchNameFromContext: async () => "must-not-rename",
    }),
  ).resolves.toEqual({ attempted: false, renamed: false, branchName: null });
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("dev");
});

test("does not mark GitHub PR checkout worktrees as eligible for first-agent rename", async () => {
  const { repoDir, tempDir } = createGitHubPrRemoteRepo();
  cleanupPaths.push(tempDir);

  const created = await createPaseoWorktree(
    {
      cwd: repoDir,
      action: "checkout",
      githubPrNumber: 123,
      runSetup: false,
      paseoHome: path.join(tempDir, ".paseo"),
    },
    createDeps(),
  );

  expect(readPaseoWorktreeMetadata(created.worktree.worktreePath)).toMatchObject({
    version: 1,
    baseRefName: "main",
  });
  await expect(
    attemptFirstAgentBranchAutoName({
      cwd: created.worktree.worktreePath,
      firstAgentContext: { prompt: "Rename PR checkout" },
      generateBranchNameFromContext: async () => "must-not-rename",
    }),
  ).resolves.toEqual({ attempted: false, renamed: false, branchName: null });
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: created.worktree.worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim(),
  ).toBe("pr-123");
});

test("does not mutate registries or broadcast when core worktree creation fails", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-worktree-service-"));
  cleanupPaths.push(tempDir);
  const deps = createDeps();

  await expect(
    createPaseoWorktree(
      {
        cwd: tempDir,
        worktreeSlug: "not-git",
        runSetup: false,
        paseoHome: path.join(tempDir, ".paseo"),
      },
      deps,
    ),
  ).rejects.toThrow("Create worktree requires a git repository");

  expect(deps.projects.size).toBe(0);
  expect(deps.workspaces.size).toBe(0);
});

interface TestDeps extends CreatePaseoWorktreeDeps {
  projects: Map<string, PersistedProjectRecord>;
  workspaces: Map<string, PersistedWorkspaceRecord>;
}

function createDeps(options?: {
  events?: string[];
  projects?: Map<string, PersistedProjectRecord>;
  workspaces?: Map<string, PersistedWorkspaceRecord>;
}): TestDeps {
  const events = options?.events ?? [];
  const projects = options?.projects ?? new Map<string, PersistedProjectRecord>();
  const workspaces = options?.workspaces ?? new Map<string, PersistedWorkspaceRecord>();

  return {
    github: createGitHubServiceStub(),
    projects,
    workspaces,
    projectRegistry: {
      get: async (projectId) => projects.get(projectId) ?? null,
      upsert: async (record) => {
        events.push(`project:${record.projectId}`);
        projects.set(record.projectId, record);
      },
    },
    workspaceRegistry: {
      get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
      list: async () => Array.from(workspaces.values()),
      upsert: async (record) => {
        events.push(`workspace:${record.workspaceId}`);
        workspaces.set(record.workspaceId, record);
      },
    },
    workspaceGitService: createWorkspaceGitServiceStub(),
  };
}

function createPersistedProjectRecordForTest(input: {
  projectId: string;
  rootPath: string;
  displayName: string;
}): PersistedProjectRecord {
  return {
    projectId: input.projectId,
    rootPath: input.rootPath,
    kind: "git",
    displayName: input.displayName,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    archivedAt: null,
  };
}

function createPersistedWorkspaceRecordForTest(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceRecord["kind"];
  displayName: string;
}): PersistedWorkspaceRecord {
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    cwd: input.cwd,
    kind: input.kind,
    displayName: input.displayName,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    archivedAt: null,
  };
}

function createGitHubServiceStub(): GitHubService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
    searchIssuesAndPrs: async () => ({ items: [], githubFeaturesEnabled: true }),
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

function createWorkspaceGitServiceStub(): WorkspaceGitService {
  return {
    registerWorkspace: () => ({
      unsubscribe: () => {},
    }),
    peekSnapshot: (cwd) => createWorkspaceGitSnapshot(cwd),
    getSnapshot: async (cwd) => createWorkspaceGitSnapshot(cwd),
    resolveRepoRoot: async (cwd) => {
      try {
        return createWorkspaceGitSnapshot(cwd).git.repoRoot ?? cwd;
      } catch {
        throw new Error("Create worktree requires a git repository");
      }
    },
    resolveDefaultBranch: async () => "main",
    refresh: async () => {},
    requestWorkingTreeWatch: async (cwd) => ({
      repoRoot: cwd,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    dispose: () => {},
  };
}

function createWorkspaceGitSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe" })
    .toString()
    .trim();
  const mainRepoRoot = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd,
      stdio: "pipe",
    },
  )
    .toString()
    .trim()
    .replace(/\/\.git$/, "");
  const currentBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();

  return {
    cwd,
    git: {
      isGit: true,
      repoRoot,
      mainRepoRoot,
      currentBranch,
      remoteUrl: null,
      isPaseoOwnedWorktree: repoRoot !== mainRepoRoot,
      isDirty: false,
      baseRef: "main",
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
    github: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
    },
  };
}

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-worktree-service-"));
  const repoDir = path.join(tempDir, "repo");
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

function createGitHubPrRemoteRepo(): { tempDir: string; repoDir: string } {
  const { tempDir, repoDir } = createGitRepo();
  execFileSync("git", ["checkout", "-b", "pr-123"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "pr branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "pr-branch"], { cwd: repoDir, stdio: "pipe" });
  const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", "pr-123"], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/123/head", prHead], {
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}
