import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import {
  createWorktree,
  deletePaseoWorktree,
  getPaseoWorktreeCleanupMarkerPath,
  getPaseoWorktreeCleanupQuarantinePath,
  hasPaseoWorktreeCleanupQuarantine,
  type WorktreeConfig,
  WorktreeCleanupRelocatedError,
} from "../utils/worktree.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveDependencies,
  type ArchiveResult,
  resolveWorkspaceIdAtPath,
} from "./workspace-archive-service.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { withWorkspaceCleanupLock } from "./workspace-cleanup-lock.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

function createLogger(): Logger {
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
}

function createPostQuarantineAbortSignal(): AbortSignal {
  const abortController = new AbortController();
  let cancellationChecks = 0;
  vi.spyOn(abortController.signal, "throwIfAborted").mockImplementation(() => {
    cancellationChecks += 1;
    if (cancellationChecks === 3) throw new Error("stop after quarantine");
  });
  return abortController.signal;
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

function createGitRepo(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(path.join(tmpdir(), "workspace-archive-service-"));
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

interface ArchiveDepsInput {
  paseoHome: string;
  activeWorkspaces: ActiveWorkspaceRef[];
  paseoWorktreesBaseRoot?: string;
  findWorkspaceIdForCwd?: (cwd: string) => Promise<string | null>;
}

interface ArchiveTestDependencies extends ArchiveDependencies {
  activeWorkspaces: ActiveWorkspaceRef[];
  archivedAgentIds: string[];
  archivedSnapshotIds: string[];
}

function createArchiveDeps(input: ArchiveDepsInput): ArchiveTestDependencies {
  const archivedWorkspaceIds = new Set<string>();
  const active = [...input.activeWorkspaces];
  const archivedAgentIds: string[] = [];
  const archivedSnapshotIds: string[] = [];
  const records = new Map<string, PersistedWorkspaceRecord>(
    active.map((workspace) => [
      workspace.workspaceId,
      createPersistedWorkspaceRecord({
        workspaceId: workspace.workspaceId,
        projectId: "project-1",
        cwd: workspace.cwd,
        kind: workspace.kind,
        displayName: workspace.workspaceId,
        worktreeRoot: workspace.worktreeRoot,
        isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    ]),
  );

  return {
    paseoHome: input.paseoHome,
    paseoWorktreesBaseRoot: input.paseoWorktreesBaseRoot,
    github: createGitHubServiceStub(),
    workspaceGitService: {
      getSnapshot: vi.fn(async () => null),
    } as unknown as Pick<WorkspaceGitService, "getSnapshot">,
    agentManager: {
      listAgents: () => [],
      archiveAgent: vi.fn(async (agentId: string) => {
        archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        archivedSnapshotIds.push(agentId);
        return {};
      }),
    },
    agentStorage: {
      list: async (): Promise<StoredAgentRecord[]> => [],
    } as Pick<AgentStorage, "list">,
    findWorkspaceIdForCwd: input.findWorkspaceIdForCwd ?? vi.fn(async () => null),
    listActiveWorkspaces: async () =>
      active.filter((workspace) => !archivedWorkspaceIds.has(workspace.workspaceId)),
    workspaceRegistry: {
      get: async (workspaceId) => records.get(workspaceId) ?? null,
      list: async () => [...records.values()],
      update: async (workspaceId, updater) => {
        const existing = records.get(workspaceId);
        if (!existing) return null;
        const updated = updater(existing);
        records.set(workspaceId, updated);
        return updated;
      },
    },
    archiveWorkspaceRecord: async (workspaceId: string, context?: WorkspaceArchiveContext) => {
      archivedWorkspaceIds.add(workspaceId);
      const existing = records.get(workspaceId);
      if (existing) {
        records.set(workspaceId, {
          ...existing,
          archivedAt: "2026-08-01T00:00:01.000Z",
          cleanupPending: context?.cleanupPending ?? existing.cleanupPending,
        });
      }
      const index = active.findIndex((workspace) => workspace.workspaceId === workspaceId);
      if (index !== -1) {
        active.splice(index, 1);
      }
    },
    emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
    markWorkspaceArchiving: vi.fn(),
    clearWorkspaceArchiving: vi.fn(),
    killTerminalsForWorkspace: vi.fn(async () => {}),
    sessionLogger: createLogger(),
    activeWorkspaces: active,
    archivedAgentIds,
    archivedSnapshotIds,
  };
}

function assertArchiveResult(
  result: ArchiveResult,
  expected: {
    archivedWorkspaceIds: string[];
    removedDirectory: boolean;
  },
): void {
  expect(result.archivedWorkspaceIds).toEqual(expected.archivedWorkspaceIds);
  expect(result.removedDirectory).toBe(expected.removedDirectory);
}

describe("archiveByScope", () => {
  test("workspace scope archives the record and removes the directory on last reference", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "last-ref-workspace");
    const workspaceId = "ws-last-ref";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-last-ref-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("workspace scope runs teardown while keeping a directory referenced by a sibling", async () => {
    const { tempDir, repoDir } = createGitRepo();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/shared-teardown.log', 'ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "shared teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "sibling-workspace");
    const workspaceA = "ws-sibling-a";
    const workspaceB = "ws-sibling-b";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: workspaceA },
        requestId: "req-sibling-workspace",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceA],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(readFileSync(path.join(repoDir, "shared-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope keeps a worktree for an active workspace in a subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-sibling");
    const sourceWorkspaceId = "ws-subdirectory-source";
    const siblingWorkspaceId = "ws-subdirectory-sibling";
    const siblingDirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(siblingDirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: sourceWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: siblingWorkspaceId,
            cwd: siblingDirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: sourceWorkspaceId },
        requestId: "req-subdirectory-sibling",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [sourceWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("archiving a subdirectory workspace keeps its active worktree root", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "subdirectory-target");
    const rootWorkspaceId = "ws-subdirectory-root";
    const subdirectoryWorkspaceId = "ws-subdirectory-target";
    const subdirectory = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(subdirectory, { recursive: true });

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: rootWorkspaceId,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: subdirectoryWorkspaceId,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId: subdirectoryWorkspaceId },
        requestId: "req-subdirectory-target",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [subdirectoryWorkspaceId],
      removedDirectory: false,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope runs teardown from the exact nested workspace before deleting its worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/nested-teardown.log', process.cwd())\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "nested teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "nested-teardown");
    const workspaceCwd = path.join(worktree.worktreePath, nestedRelative);
    const matchesWorkspaceCwd = createRealpathAwarePathMatcher(workspaceCwd);
    const workspaceId = "ws-nested-teardown";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId,
            cwd: workspaceCwd,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
            mainRepoRoot: repoDir,
          },
        ],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-nested-teardown",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(
      matchesWorkspaceCwd(readFileSync(path.join(repoDir, "nested-teardown.log"), "utf8")),
    ).toBe(true);
  });

  test("worktree scope archives root and subdirectory workspaces before removing the backing worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const nestedRelative = path.join("packages", "app");
    const sourceNested = path.join(repoDir, nestedRelative);
    mkdirSync(sourceNested, { recursive: true });
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"const fs=require('fs');const out=process.env.PASEO_SOURCE_CHECKOUT_PATH+'/root-scope-teardown.log';if(fs.existsSync(out))process.exit(2);fs.writeFileSync(out,'ok')\"",
          ],
        },
      }),
    );
    writeFileSync(
      path.join(sourceNested, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').writeFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH+'/nested-scope-teardown.log','ok')\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "scope teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope");
    const workspaceA = "ws-worktree-a";
    const workspaceB = "ws-worktree-b";
    const workspaceC = "ws-worktree-subdirectory";
    const subdirectory = path.join(worktree.worktreePath, nestedRelative);

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          {
            workspaceId: workspaceA,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceB,
            cwd: worktree.worktreePath,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
          {
            workspaceId: workspaceC,
            cwd: subdirectory,
            kind: "worktree",
            worktreeRoot: worktree.worktreePath,
            isPaseoOwnedWorktree: true,
          },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect(readFileSync(path.join(repoDir, "root-scope-teardown.log"), "utf8")).toBe("ok");
    expect(readFileSync(path.join(repoDir, "nested-scope-teardown.log"), "utf8")).toBe("ok");
  });

  test("workspace scope never removes a non-Paseo-owned directory", async () => {
    const { tempDir } = createGitRepo();
    const localCheckoutDir = mkdtempSync(path.join(tempDir, "local-checkout-"));
    const workspaceId = "ws-local-checkout";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome: path.join(tempDir, ".paseo"),
        activeWorkspaces: [{ workspaceId, cwd: localCheckoutDir, kind: "local_checkout" }],
      }),
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-local-checkout",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
    });
    expect(existsSync(localCheckoutDir)).toBe(true);
  });

  test("worktree scope keeps the directory when one record teardown fails", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "partial-failure");
    const workspaceA = "ws-partial-a";
    const workspaceB = "ws-partial-b";
    const workspaceACwd = path.join(worktree.worktreePath, "packages", "a");
    const workspaceBCwd = path.join(worktree.worktreePath, "packages", "b");
    mkdirSync(workspaceACwd, { recursive: true });
    mkdirSync(workspaceBCwd, { recursive: true });

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: workspaceACwd, kind: "worktree" },
        { workspaceId: workspaceB, cwd: workspaceBCwd, kind: "worktree" },
      ],
    });
    deps.runTeardownCommands = vi.fn(async () => []);
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (
      workspaceId: string,
      context?: WorkspaceArchiveContext,
    ) => {
      if (workspaceId === workspaceA) {
        throw new Error("intentional teardown failure");
      }
      return originalArchiveWorkspaceRecord(workspaceId, context);
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-partial-failure",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceB]);
    expect(result.archivedWorkspaceIds).not.toContain(workspaceA);
    expect(result.removedDirectory).toBe(false);
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect(deps.runTeardownCommands).toHaveBeenCalledTimes(1);
    expect(deps.runTeardownCommands).toHaveBeenCalledWith(
      expect.objectContaining({ teardownCwd: workspaceBCwd }),
    );
  });

  test("retains cleanup ownership after a failed removal and retries without re-archiving", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-retry");
    const workspaceId = "ws-cleanup-retry";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.runTeardownCommands = vi.fn(async () => []);
    const archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);
    deps.archiveWorkspaceRecord = archiveWorkspaceRecord;
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("simulated recursive deletion failure");
    });

    const first = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-retry-first",
    });

    expect(first).toMatchObject({
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
      cleanupPending: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);
    const pendingCleanup = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(pendingCleanup).toMatchObject({
      workspaceId,
      attemptCount: 1,
      lastError: "simulated recursive deletion failure",
    });
    expect(
      createRealpathAwarePathMatcher(worktree.worktreePath)(pendingCleanup?.backingPath ?? ""),
    ).toBe(true);

    deps.deleteWorktree = undefined;
    const retried = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-retry-after-restart",
    });

    expect(retried).toMatchObject({
      archivedWorkspaceIds: [],
      removedDirectory: true,
      cleanupPending: false,
    });
    expect(archiveWorkspaceRecord).toHaveBeenCalledTimes(1);
    expect(deps.runTeardownCommands).toHaveBeenCalledTimes(1);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending).toBeNull();
  });

  test("publishes archive cleanup ownership only after acquiring the worktree-root lock", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "archive-root-lock");
    const workspaceId = "ws-archive-root-lock";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    const lockStarted = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const heldLock = withWorkspaceCleanupLock(path.dirname(worktree.worktreePath), async () => {
      lockStarted.resolve();
      await releaseLock.promise;
    });
    await lockStarted.promise;

    const archive = archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-archive-root-lock",
    });
    await Promise.resolve();
    expect((await deps.workspaceRegistry.get(workspaceId))?.archivedAt).toBeNull();

    releaseLock.resolve();
    await heldLock;
    await archive;
    expect((await deps.workspaceRegistry.get(workspaceId))?.archivedAt).not.toBeNull();
  });

  test("uses the persisted worktrees root after configuration changes", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const originalRoot = path.join(tempDir, "original-worktrees");
    const worktree = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "persisted-root",
      source: {
        kind: "branch-off",
        baseBranch: "main",
        branchName: "persisted-root",
      },
      runSetup: false,
      paseoHome,
      worktreesRoot: originalRoot,
    });
    const workspaceId = "ws-persisted-root";
    const deps = createArchiveDeps({
      paseoHome,
      paseoWorktreesBaseRoot: path.join(tempDir, "new-worktrees"),
      activeWorkspaces: [
        {
          workspaceId,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    deps.deleteWorktree = vi.fn(async () => undefined);

    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-persisted-root",
    });

    expect(deps.deleteWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreesRoot: path.dirname(worktree.worktreePath) }),
    );
  });

  test("checkpoints each successful teardown before a later teardown fails", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "teardown-checkpoint");
    const firstCwd = worktree.worktreePath;
    const secondCwd = path.join(worktree.worktreePath, "nested");
    mkdirSync(secondCwd);
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: "ws-teardown-first", cwd: firstCwd, kind: "worktree" },
        { workspaceId: "ws-teardown-second", cwd: secondCwd, kind: "worktree" },
      ],
    });
    let failSecond = true;
    deps.runTeardownCommands = vi.fn(async ({ teardownCwd }) => {
      if (teardownCwd === secondCwd && failSecond) throw new Error("second teardown failed");
      return [];
    });
    deps.deleteWorktree = vi.fn(async () => undefined);

    const first = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-teardown-checkpoint-first",
    });
    expect(first.cleanupPending).toBe(true);
    expect(
      (await deps.workspaceRegistry.get("ws-teardown-first"))?.cleanupPending?.teardownCwds,
    ).toEqual([]);

    failSecond = false;
    const selectedReceipt = (await deps.workspaceRegistry.get("ws-teardown-second"))
      ?.cleanupPending;
    await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId: "ws-teardown-second", receipt: selectedReceipt! },
      requestId: "req-teardown-checkpoint-retry",
    });

    expect(deps.runTeardownCommands).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(deps.runTeardownCommands).mock.calls.map(([input]) => input.teardownCwd),
    ).toEqual([firstCwd, secondCwd, secondCwd]);
  });

  test("does not run cleanup selected from an older receipt generation", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-generation");
    const workspaceId = "ws-cleanup-generation";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("leave cleanup pending");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-generation-first",
    });
    const selectedReceipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    await deps.workspaceRegistry.update(workspaceId, (workspace) => ({
      ...workspace,
      cleanupPending: workspace.cleanupPending
        ? { ...workspace.cleanupPending, createdAt: "2026-08-01T00:00:02.000Z" }
        : null,
    }));
    vi.mocked(deps.deleteWorktree).mockClear();

    const result = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: selectedReceipt! },
      requestId: "req-cleanup-generation-stale",
    });

    expect(result.removedDirectory).toBe(false);
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending?.createdAt).toBe(
      "2026-08-01T00:00:02.000Z",
    );
  });

  test("moves durable cleanup ownership when a quarantined directory remains", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-relocated");
    const workspaceId = "ws-cleanup-relocated";
    const relocatedPath = path.join(
      path.dirname(worktree.worktreePath),
      ".paseo-cleanup-relocated",
    );
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new WorktreeCleanupRelocatedError(
        relocatedPath,
        "00000000-0000-4000-8000-000000000099",
        new Error("remove failed"),
      );
    });

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-relocated",
    });

    expect(result.cleanupPending).toBe(true);
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending).toMatchObject({
      backingPath: relocatedPath,
      worktreeIncarnationId: "00000000-0000-4000-8000-000000000099",
      lastError: `Worktree cleanup remains at ${relocatedPath}`,
    });
  });

  test("refuses a cleanup retry when the archived path has been replaced", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-identity");
    const workspaceId = "ws-cleanup-identity";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("simulated deletion failure");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-identity-first",
    });

    rmSync(worktree.worktreePath, { recursive: true, force: true });
    mkdirSync(worktree.worktreePath, { recursive: true });
    writeFileSync(path.join(worktree.worktreePath, "replacement.txt"), "keep");
    const replacementStats = statSync(worktree.worktreePath);
    await deps.workspaceRegistry.update(workspaceId, (workspace) => ({
      ...workspace,
      cleanupPending: workspace.cleanupPending
        ? {
            ...workspace.cleanupPending,
            directoryIdentity: `${replacementStats.dev}:${replacementStats.ino}`,
          }
        : null,
    }));
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("replacement path must not be deleted");
    });

    const retried = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-identity-retry",
    });

    expect(retried.cleanupPending).toBe(true);
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(readFileSync(path.join(worktree.worktreePath, "replacement.txt"), "utf8")).toBe("keep");
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending?.lastError).toContain(
      "incarnation changed",
    );
  });

  test("does not use a legacy directory identity as deletion authority", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "legacy-receipt");
    const workspaceId = "ws-legacy-receipt";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("leave cleanup pending");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-legacy-receipt-first",
    });
    await deps.workspaceRegistry.update(workspaceId, (workspace) => ({
      ...workspace,
      cleanupPending: workspace.cleanupPending
        ? { ...workspace.cleanupPending, worktreeIncarnationId: undefined }
        : null,
    }));
    deps.deleteWorktree = vi.fn(async () => undefined);

    const retried = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-legacy-receipt-retry",
    });

    expect(retried.cleanupPending).toBe(true);
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("keeps a legacy receipt pending when only its old quarantine may remain", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "legacy-quarantine");
    const workspaceId = "ws-legacy-quarantine";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("leave cleanup pending");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-legacy-quarantine-first",
    });
    const receipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(receipt?.directoryIdentity).toEqual(expect.any(String));
    const identityHash = createHash("sha256")
      .update(receipt!.directoryIdentity!)
      .digest("hex")
      .slice(0, 16);
    const legacyQuarantinePath = path.join(
      path.dirname(worktree.worktreePath),
      `.paseo-cleanup-${path.basename(worktree.worktreePath)}-${identityHash}`,
    );
    renameSync(worktree.worktreePath, legacyQuarantinePath);
    await deps.workspaceRegistry.update(workspaceId, (workspace) => ({
      ...workspace,
      cleanupPending: workspace.cleanupPending
        ? { ...workspace.cleanupPending, worktreeIncarnationId: undefined }
        : null,
    }));
    deps.deleteWorktree = vi.fn(async () => undefined);

    const retried = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-legacy-quarantine-retry",
    });

    expect(retried).toMatchObject({ removedDirectory: false, cleanupPending: true });
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(existsSync(legacyQuarantinePath)).toBe(true);
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending?.lastError).toContain(
      "incarnation is missing",
    );
  });

  test("does not report an already-absent modern cleanup path as removed", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-already-absent");
    const workspaceId = "ws-cleanup-already-absent";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("leave cleanup pending");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-already-absent-first",
    });
    const receipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(receipt?.worktreeIncarnationId).toEqual(expect.any(String));
    rmSync(worktree.worktreePath, { recursive: true, force: true });
    deps.deleteWorktree = vi.fn(async () => undefined);

    const retried = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: receipt! },
      requestId: "req-cleanup-already-absent-retry",
    });

    expect(retried).toMatchObject({ removedDirectory: false, cleanupPending: false });
    expect(deps.deleteWorktree).toHaveBeenCalledTimes(1);
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending).toBeNull();
  });

  test("retries crash-left quarantine after restart without removing an active replacement", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-crash-quarantine");
    const workspaceId = "ws-cleanup-crash-quarantine";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("simulated crash before receipt relocation");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-crash-quarantine-first",
    });
    const receipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(receipt?.worktreeIncarnationId).toEqual(expect.any(String));
    expect(receipt?.quarantineMarker).toEqual(expect.any(String));

    const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
      worktree.worktreePath,
      receipt!.worktreeIncarnationId!,
    );
    writeFileSync(
      getPaseoWorktreeCleanupMarkerPath(worktree.worktreePath, receipt!.quarantineMarker!),
      "",
    );
    renameSync(worktree.worktreePath, quarantinePath);
    await expect(
      hasPaseoWorktreeCleanupQuarantine(
        worktree.worktreePath,
        receipt!.worktreeIncarnationId!,
        receipt!.quarantineMarker,
      ),
    ).resolves.toBe(true);
    mkdirSync(worktree.worktreePath, { recursive: true });
    writeFileSync(path.join(worktree.worktreePath, "replacement.txt"), "keep");
    deps.activeWorkspaces.push({
      workspaceId: "ws-replacement",
      cwd: worktree.worktreePath,
      kind: "worktree",
      worktreeRoot: worktree.worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
    });
    deps.deleteWorktree = vi.fn(deletePaseoWorktree);

    const retried = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: receipt! },
      requestId: "req-cleanup-crash-quarantine-retry",
    });

    const remainingReceipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect({
      ...retried,
      deleteCalls: vi.mocked(deps.deleteWorktree).mock.calls.length,
      lastError: remainingReceipt?.lastError,
    }).toMatchObject({
      removedDirectory: true,
      cleanupPending: false,
      deleteCalls: 1,
      lastError: undefined,
    });
    expect(readFileSync(path.join(worktree.worktreePath, "replacement.txt"), "utf8")).toBe("keep");
    expect(existsSync(quarantinePath)).toBe(false);
  });

  test("keeps cleanup pending when a quarantine path is replaced", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-quarantine-swap");
    const workspaceId = "ws-cleanup-quarantine-swap";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    let genuineQuarantinePath = "";
    deps.deleteWorktree = vi.fn(async (options) => {
      try {
        await deletePaseoWorktree({ ...options, signal: createPostQuarantineAbortSignal() });
      } catch (error) {
        if (!(error instanceof WorktreeCleanupRelocatedError)) throw error;
        genuineQuarantinePath = `${error.remainingPath}.moved`;
        renameSync(error.remainingPath, genuineQuarantinePath);
        mkdirSync(error.remainingPath);
        writeFileSync(path.join(error.remainingPath, "replacement.txt"), "keep");
        throw error;
      }
    });

    const first = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-quarantine-swap-first",
    });
    const receipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(first.cleanupPending).toBe(true);
    expect(receipt?.backingPath).toContain(".paseo-cleanup-cleanup-quarantine-swap-");
    expect(existsSync(genuineQuarantinePath)).toBe(true);
    expect(readFileSync(path.join(receipt!.backingPath, "replacement.txt"), "utf8")).toBe("keep");

    deps.deleteWorktree = vi.fn(deletePaseoWorktree);
    const retried = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: receipt! },
      requestId: "req-cleanup-quarantine-swap-retry",
    });

    const remainingReceipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(retried).toMatchObject({ removedDirectory: false, cleanupPending: true });
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(readFileSync(path.join(receipt!.backingPath, "replacement.txt"), "utf8")).toBe("keep");
    expect(existsSync(genuineQuarantinePath)).toBe(true);
    expect(remainingReceipt?.lastError).toContain("quarantine marker changed");
  });

  test("adds a quarantine marker when retrying a markerless receipt", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-legacy-marker");
    const workspaceId = "ws-cleanup-legacy-marker";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("leave cleanup pending");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-legacy-marker-first",
    });
    await deps.workspaceRegistry.update(workspaceId, (workspace) => ({
      ...workspace,
      cleanupPending: workspace.cleanupPending
        ? { ...workspace.cleanupPending, quarantineMarker: undefined }
        : null,
    }));
    const markerlessReceipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    deps.deleteWorktree = vi.fn((options) =>
      deletePaseoWorktree({ ...options, signal: createPostQuarantineAbortSignal() }),
    );

    const interrupted = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: markerlessReceipt! },
      requestId: "req-cleanup-legacy-marker-interrupted",
    });
    const relocatedReceipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;

    expect(interrupted).toMatchObject({ removedDirectory: false, cleanupPending: true });
    expect(relocatedReceipt).toMatchObject({
      backingPath: expect.stringContaining(".paseo-cleanup-cleanup-legacy-marker-"),
      quarantineMarker: expect.any(String),
    });
    expect(
      existsSync(
        getPaseoWorktreeCleanupMarkerPath(
          relocatedReceipt!.backingPath,
          relocatedReceipt!.quarantineMarker!,
        ),
      ),
    ).toBe(true);

    deps.deleteWorktree = vi.fn(deletePaseoWorktree);
    const retried = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: relocatedReceipt! },
      requestId: "req-cleanup-legacy-marker-retry",
    });

    expect(retried).toMatchObject({ removedDirectory: true, cleanupPending: false });
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending).toBeNull();
  });

  test("does not retry cleanup selected before the workspace was restored", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-restored");
    const workspaceId = "ws-cleanup-restored";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.deleteWorktree = vi.fn(async () => {
      throw new Error("simulated deletion failure");
    });
    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-restored-first",
    });
    const selectedReceipt = (await deps.workspaceRegistry.get(workspaceId))?.cleanupPending;
    expect(selectedReceipt).not.toBeNull();

    let activeWorkspaceReads = 0;
    deps.listActiveWorkspaces = async () => {
      activeWorkspaceReads += 1;
      if (activeWorkspaceReads === 2) {
        await deps.workspaceRegistry.update(workspaceId, (workspace) => ({
          ...workspace,
          archivedAt: null,
          cleanupPending: null,
        }));
      }
      return [];
    };
    deps.deleteWorktree = vi.fn(async () => undefined);

    const retried = await archiveByScope(deps, {
      scope: { kind: "cleanup", workspaceId, receipt: selectedReceipt! },
      requestId: "req-cleanup-restored-retry",
    });

    expect(retried).toMatchObject({
      archivedWorkspaceIds: [],
      removedDirectory: false,
      cleanupPending: false,
    });
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(activeWorkspaceReads).toBe(2);
    expect(existsSync(worktree.worktreePath)).toBe(true);
    expect((await deps.workspaceRegistry.get(workspaceId))?.archivedAt).toBeNull();
  });

  test("refuses deletion when teardown replaces the cleanup directory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-teardown-replace");
    const workspaceId = "ws-cleanup-teardown-replace";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.runTeardownCommands = vi.fn(async () => {
      rmSync(worktree.worktreePath, { recursive: true, force: true });
      mkdirSync(worktree.worktreePath, { recursive: true });
      writeFileSync(path.join(worktree.worktreePath, "replacement.txt"), "keep");
    });
    deps.deleteWorktree = vi.fn(async () => undefined);

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-teardown-replace",
    });

    expect(result.cleanupPending).toBe(true);
    expect(deps.deleteWorktree).not.toHaveBeenCalled();
    expect(readFileSync(path.join(worktree.worktreePath, "replacement.txt"), "utf8")).toBe("keep");
    expect((await deps.workspaceRegistry.get(workspaceId))?.cleanupPending?.lastError).toContain(
      "incarnation changed",
    );
  });

  test("workspace scope with unknown workspace id is a clean no-op", async () => {
    const { tempDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = vi.fn(
      async (workspaceId: string, context?: WorkspaceArchiveContext) => {
        return originalArchiveWorkspaceRecord(workspaceId, context);
      },
    );

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: "ws-does-not-exist" },
      requestId: "req-unknown-workspace",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [],
      removedDirectory: false,
    });
    expect(deps.markWorkspaceArchiving).not.toHaveBeenCalled();
    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(deps.emitWorkspaceUpdatesForWorkspaceIds).not.toHaveBeenCalled();
  });

  test("worktree scope removes an owned directory with zero matching records", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "zero-records");

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-zero-records",
      },
    );

    assertArchiveResult(result, {
      archivedWorkspaceIds: [],
      removedDirectory: true,
    });
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("marks archiving, emits an upsert carrying the archiving state, then clears it and emits a remove", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "lifecycle");
    const workspaceId = "ws-lifecycle";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });

    const archivingByWorkspaceId = new Map<string, string>();
    type LifecycleEvent =
      | { type: "mark"; workspaceIds: string[]; archivingAt: string }
      | {
          type: "emit";
          workspaceIds: string[];
          updates: Array<{
            kind: "upsert" | "remove";
            workspaceId: string;
            archivingAt: string | null;
          }>;
        }
      | { type: "archive"; workspaceId: string }
      | { type: "clear"; workspaceIds: string[] };
    const events: LifecycleEvent[] = [];

    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string, context?: WorkspaceArchiveContext) => {
      await originalArchiveWorkspaceRecord(id, context);
      events.push({ type: "archive", workspaceId: id });
    };
    deps.markWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>, archivingAt: string) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.set(id, archivingAt);
      }
      events.push({ type: "mark", workspaceIds: Array.from(workspaceIds), archivingAt });
    });
    deps.clearWorkspaceArchiving = vi.fn((workspaceIds: Iterable<string>) => {
      for (const id of workspaceIds) {
        archivingByWorkspaceId.delete(id);
      }
      events.push({ type: "clear", workspaceIds: Array.from(workspaceIds) });
    });
    deps.emitWorkspaceUpdatesForWorkspaceIds = vi.fn(async (workspaceIds: Iterable<string>) => {
      const ids = Array.from(workspaceIds);
      const activeIds = new Set<string>();
      for (const workspace of deps.activeWorkspaces) {
        activeIds.add(workspace.workspaceId);
      }
      const updates: Array<{
        kind: "upsert" | "remove";
        workspaceId: string;
        archivingAt: string | null;
      }> = [];
      for (const id of ids) {
        const archivingAt = archivingByWorkspaceId.get(id) ?? null;
        if (archivingAt && activeIds.has(id)) {
          updates.push({ kind: "upsert", workspaceId: id, archivingAt });
        } else {
          updates.push({ kind: "remove", workspaceId: id, archivingAt: null });
        }
      }
      events.push({ type: "emit", workspaceIds: ids, updates });
    });

    await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-lifecycle",
    });

    expect(events.map((event) => event.type)).toEqual(["mark", "emit", "archive", "clear", "emit"]);

    const firstEmit = events[1] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(firstEmit.workspaceIds).toEqual([workspaceId]);
    expect(firstEmit.updates).toEqual([
      { kind: "upsert", workspaceId, archivingAt: expect.any(String) },
    ]);

    const secondEmit = events[4] as Extract<LifecycleEvent, { type: "emit" }>;
    expect(secondEmit.workspaceIds).toEqual([workspaceId]);
    expect(secondEmit.updates).toEqual([{ kind: "remove", workspaceId, archivingAt: null }]);
  });

  test("archives stored snapshots only for the target workspace", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "snapshot-scope");
    const targetWorkspaceId = "ws-snapshot-target";
    const otherWorkspaceId = "ws-snapshot-other";
    const liveAgentId = "agent-live";
    const targetStoredAgentId = "agent-stored-target";
    const otherStoredAgentId = "agent-stored-other";

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: targetWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    deps.agentManager = {
      listAgents: () => [{ id: liveAgentId, workspaceId: targetWorkspaceId }] as ManagedAgent[],
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, _archivedAt: string) => {
        deps.archivedSnapshotIds.push(agentId);
        return {};
      }),
    };
    deps.agentStorage = {
      list: async () =>
        [
          { id: targetStoredAgentId, workspaceId: targetWorkspaceId, archivedAt: null },
          { id: otherStoredAgentId, workspaceId: otherWorkspaceId, archivedAt: null },
        ] as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: targetWorkspaceId },
      requestId: "req-snapshot-scope",
    });

    assertArchiveResult(result, {
      archivedWorkspaceIds: [targetWorkspaceId],
      removedDirectory: true,
    });
    expect(result.archivedAgentIds).toContain(liveAgentId);
    expect(result.archivedAgentIds).toContain(targetStoredAgentId);
    expect(result.archivedAgentIds).not.toContain(otherStoredAgentId);
    expect(deps.archivedSnapshotIds).toEqual([targetStoredAgentId]);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("worktree scope archives three workspaces on the directory and removes it", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "worktree-scope-n3");
    const workspaceA = "ws-worktree-n3-a";
    const workspaceB = "ws-worktree-n3-b";
    const workspaceC = "ws-worktree-n3-c";

    const result = await archiveByScope(
      createArchiveDeps({
        paseoHome,
        activeWorkspaces: [
          { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
          { workspaceId: workspaceC, cwd: worktree.worktreePath, kind: "local_checkout" },
        ],
      }),
      {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-worktree-scope-n3",
      },
    );

    expect(result.archivedWorkspaceIds).toEqual(
      expect.arrayContaining([workspaceA, workspaceB, workspaceC]),
    );
    expect(result.archivedWorkspaceIds).toHaveLength(3);
    expect(result.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });
});

describe("resolveWorkspaceIdAtPath", () => {
  test("prefers the worktree-kind record on an exact cwd tie", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-local", cwd: targetPath, kind: "local_checkout" },
          { workspaceId: "ws-worktree", cwd: targetPath, kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-local"),
      },
      targetPath,
    );

    expect(result).toBe("ws-worktree");
  });

  test("falls back to the path resolver when there is no exact match", async () => {
    const targetPath = "/worktrees/repo/feature";

    const result = await resolveWorkspaceIdAtPath(
      {
        listActiveWorkspaces: async () => [
          { workspaceId: "ws-nested", cwd: "/worktrees/repo", kind: "worktree" },
        ],
        findWorkspaceIdForCwd: vi.fn(async () => "ws-nested"),
      },
      targetPath,
    );

    expect(result).toBe("ws-nested");
  });
});
