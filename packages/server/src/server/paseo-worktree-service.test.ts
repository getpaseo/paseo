import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { GitHubService } from "../services/github-service.js";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { createPaseoWorktree, type CreatePaseoWorktreeDeps } from "./paseo-worktree-service.js";
import { createWorktreeCoreDeps } from "./worktree-core.js";

describe("createPaseoWorktree", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("creates a worktree, registers the workspace, primes fingerprints, and broadcasts in order", async () => {
    const { repoDir, tempDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const events: string[] = [];
    const deps = createDeps({ events });

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
    expect(events).toEqual([
      `project:${result.workspace.projectId}`,
      `workspace:${result.workspace.workspaceId}`,
      `prime:${result.workspace.workspaceId}`,
      `broadcast:${result.workspace.workspaceId}`,
    ]);
  });

  test("reuses an existing worktree and still upserts and broadcasts", async () => {
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
    expect(events).toContain(`broadcast:${second.workspace.workspaceId}`);
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
    expect(deps.broadcastWorkspaceUpdate).not.toHaveBeenCalled();
    expect(deps.primeWorkspaceGitWatchFingerprints).not.toHaveBeenCalled();
  });

  test("keeps direct core worktree creation calls behind the service boundary", () => {
    // Keep this literal in the test file so the grep invariant sees createWorktreeCore( here.
    const serverSrc = path.dirname(fileURLToPath(import.meta.url));
    const matches = listTypeScriptFiles(serverSrc).flatMap((filePath) => {
      if (path.basename(filePath) === "worktree-core.ts") {
        return [];
      }
      const contents = readFileSync(filePath, "utf8");
      const pattern = new RegExp(["createWorktreeCore", "\\("].join(""), "g");
      return Array.from(contents.matchAll(pattern), () => path.relative(serverSrc, filePath));
    });

    expect(matches).toEqual(["paseo-worktree-service.test.ts", "paseo-worktree-service.ts"]);
  });
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
    ...createWorktreeCoreDeps(createGitHubServiceStub()),
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
    primeWorkspaceGitWatchFingerprints: vi.fn(async (workspace: PersistedWorkspaceRecord) => {
      events.push(`prime:${workspace.workspaceId}`);
    }),
    broadcastWorkspaceUpdate: vi.fn(async (workspaceId: string) => {
      events.push(`broadcast:${workspaceId}`);
    }),
  };
}

function createGitHubServiceStub(): GitHubService {
  return {
    listPullRequests: async () => [],
    listIssues: async () => [],
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
    isAuthenticated: async () => true,
    invalidate: () => {},
  };
}

function createWorkspaceGitServiceStub(): WorkspaceGitService {
  return {
    subscribe: async (params) => ({
      initial: createWorkspaceGitSnapshot(params.cwd),
      unsubscribe: () => {},
    }),
    peekSnapshot: (cwd) => createWorkspaceGitSnapshot(cwd),
    getSnapshot: async (cwd) => createWorkspaceGitSnapshot(cwd),
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
  const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, stdio: "pipe" })
    .toString()
    .trim();
  const mainRepoRoot = execSync("git rev-parse --path-format=absolute --git-common-dir", {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim()
    .replace(/\/\.git$/, "");
  const currentBranch = execSync("git branch --show-current", { cwd, stdio: "pipe" })
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
      aheadBehind: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      diffStat: null,
    },
    github: {
      featuresEnabled: false,
      pullRequest: null,
      error: null,
      refreshedAt: null,
    },
  };
}

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-worktree-service-"));
  const repoDir = path.join(tempDir, "repo");
  execSync(`git init ${JSON.stringify(repoDir)}`, { stdio: "pipe" });
  execSync("git config user.email test@example.com", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  execSync("git add README.md", { cwd: repoDir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: repoDir, stdio: "pipe" });
  execSync("git branch -M main", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

function listTypeScriptFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  return entries.flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return listTypeScriptFiles(fullPath);
    }
    return fullPath.endsWith(".ts") ? [fullPath] : [];
  });
}
