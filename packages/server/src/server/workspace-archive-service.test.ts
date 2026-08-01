import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { createWorktree, type WorktreeConfig } from "../utils/worktree.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveDependencies,
  type ArchiveResult,
  requireActiveWorkspaceForArchive,
  resolveWorkspaceIdAtPath,
} from "./workspace-archive-service.js";
import { WorkspaceLifecycleCoordinator } from "./workspace-lifecycle-coordinator.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "./workspace-registry.js";

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
function removeManagedAgentById(agents: ManagedAgent[], agentId: string): void {
  const index = agents.findIndex((agent) => agent.id === agentId);
  if (index !== -1) {
    agents.splice(index, 1);
  }
}

function findStoredAgentById(
  records: StoredAgentRecord[],
  agentId: string,
): StoredAgentRecord | undefined {
  return records.find((record) => record.id === agentId);
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
    archiveWorkspaceRecord: async (workspaceId: string) => {
      archivedWorkspaceIds.add(workspaceId);
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
  test("treats persisted cleanup as a retryable workspace archive target", async () => {
    const persisted = createPersistedWorkspaceRecord({
      workspaceId: "ws-cleanup-retry-target",
      projectId: "project-cleanup-retry-target",
      cwd: "/tmp/cleanup-retry-target",
      kind: "worktree",
      displayName: "Cleanup retry target",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      archivedAt: "2026-07-31T00:01:00.000Z",
      cleanupPending: {
        directoryPath: "/tmp/cleanup-retry-target",
        teardownCwd: "/tmp/cleanup-retry-target",
        mainRepoRoot: "/tmp/repo",
        paseoWorktreesRoot: "/tmp/worktrees",
        worktreeIncarnationId: "incarnation-retry",
      },
    });

    await expect(
      requireActiveWorkspaceForArchive(
        {
          listActiveWorkspaces: async () => [],
          workspaceRegistry: { get: async () => persisted },
        },
        persisted.workspaceId,
      ),
    ).resolves.toBe(persisted);
  });

  test("waits for registered setup before archiving its workspace", async () => {
    const { tempDir } = createGitRepo();
    const workspaceId = "ws-setup-race";
    const workspaceCwd = path.join(tempDir, "local-checkout");
    mkdirSync(workspaceCwd);
    const lifecycleCoordinator = new WorkspaceLifecycleCoordinator();
    let finishSetup: (() => void) | undefined;
    const setupTask = new Promise<void>((resolveSetup) => {
      finishSetup = resolveSetup;
    });
    lifecycleCoordinator.trackWorkspaceSetup(workspaceId, setupTask);
    let markWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolveWaitStarted) => {
      markWaitStarted = resolveWaitStarted;
    });
    const waitForWorkspaceSetups =
      lifecycleCoordinator.waitForWorkspaceSetups.bind(lifecycleCoordinator);
    vi.spyOn(lifecycleCoordinator, "waitForWorkspaceSetups").mockImplementation(
      async (workspaceIds) => {
        markWaitStarted?.();
        await waitForWorkspaceSetups(workspaceIds);
      },
    );
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId, cwd: workspaceCwd, kind: "local_checkout" }],
    });
    deps.lifecycleCoordinator = lifecycleCoordinator;
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    const archiveTask = archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-setup-race",
    });

    await waitStarted;
    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();

    finishSetup?.();
    await expect(archiveTask).resolves.toMatchObject({
      archivedWorkspaceIds: [workspaceId],
    });
  });

  test("coalesces simultaneous archive requests for the same backing directory", async () => {
    const { tempDir } = createGitRepo();
    const workspaceId = "ws-simultaneous";
    const workspaceCwd = path.join(tempDir, "local-checkout");
    mkdirSync(workspaceCwd);
    const lifecycleCoordinator = new WorkspaceLifecycleCoordinator();
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId, cwd: workspaceCwd, kind: "local_checkout" }],
    });
    deps.lifecycleCoordinator = lifecycleCoordinator;
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolveArchive) => {
      releaseArchive = resolveArchive;
    });
    let markArchiveStarted: (() => void) | undefined;
    const archiveStarted = new Promise<void>((resolveStarted) => {
      markArchiveStarted = resolveStarted;
    });
    deps.archiveWorkspaceRecord = vi.fn(async (id: string) => {
      markArchiveStarted?.();
      await archiveGate;
      await originalArchiveWorkspaceRecord(id);
    });

    const first = archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-simultaneous-first",
    });
    const second = archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-simultaneous-second",
    });
    await archiveStarted;
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledTimes(1);
    expect(() => lifecycleCoordinator.reserveWorkspaceOwnershipMutation(workspaceId)).toThrow(
      `Workspace ${workspaceId} is being archived`,
    );

    releaseArchive?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledTimes(1);
    const postArchiveReservation =
      lifecycleCoordinator.reserveWorkspaceOwnershipMutation(workspaceId);
    postArchiveReservation.release();
  });

  test("archives sibling workspace records separately while serializing shared cleanup", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "concurrent-siblings");
    const workspaceA = "ws-concurrent-sibling-a";
    const workspaceB = "ws-concurrent-sibling-b";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    deps.lifecycleCoordinator = new WorkspaceLifecycleCoordinator();
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    const [resultA, resultB] = await Promise.all([
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: workspaceA },
        requestId: "req-concurrent-sibling-a",
      }),
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: workspaceB },
        requestId: "req-concurrent-sibling-b",
      }),
    ]);

    expect(resultA.archivedWorkspaceIds).toEqual([workspaceA]);
    expect(resultB.archivedWorkspaceIds).toEqual([workspaceB]);
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledTimes(2);
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceA);
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceB);
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("holds final owner recheck and deletion behind sibling setup reservation", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "reserved-sibling");
    const workspaceId = "ws-reserved-target";
    const siblingWorkspaceId = "ws-reserved-sibling";
    const lifecycleCoordinator = new WorkspaceLifecycleCoordinator();
    const reservation = lifecycleCoordinator.reserveWorkspaceSetup(
      siblingWorkspaceId,
      worktree.worktreePath,
    );
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
        },
      ],
    });
    deps.lifecycleCoordinator = lifecycleCoordinator;
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    let markRecordArchived: (() => void) | undefined;
    const recordArchived = new Promise<void>((resolveArchived) => {
      markRecordArchived = resolveArchived;
    });
    deps.archiveWorkspaceRecord = async (id: string) => {
      await originalArchiveWorkspaceRecord(id);
      deps.activeWorkspaces.push({
        workspaceId: siblingWorkspaceId,
        cwd: path.join(worktree.worktreePath, "packages", "app"),
        kind: "worktree",
        worktreeRoot: worktree.worktreePath,
        isPaseoOwnedWorktree: true,
      });
      markRecordArchived?.();
    };

    const archiveTask = archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-reserved-sibling",
    });
    await recordArchived;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(existsSync(worktree.worktreePath)).toBe(true);

    reservation.release();
    const result = await archiveTask;
    expect(result.removedDirectory).toBe(false);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

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

  test("workspace scope skips teardown while a sibling still references the directory", async () => {
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
    expect(existsSync(path.join(repoDir, "shared-teardown.log"))).toBe(false);
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

  test("rechecks owners after archival before removing the backing directory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "late-owner");
    const workspaceId = "ws-late-owner-target";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
        },
      ],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string) => {
      await originalArchiveWorkspaceRecord(id);
      deps.activeWorkspaces.push({
        workspaceId: "ws-late-owner-sibling",
        cwd: path.join(worktree.worktreePath, "packages", "app"),
        kind: "worktree",
        worktreeRoot: worktree.worktreePath,
        isPaseoOwnedWorktree: true,
      });
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-late-owner",
    });

    expect(result.removedDirectory).toBe(false);
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

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: workspaceA, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: workspaceB, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (workspaceId: string) => {
      if (workspaceId === workspaceA) {
        throw new Error("intentional teardown failure");
      }
      return originalArchiveWorkspaceRecord(workspaceId);
    };

    await expect(
      archiveByScope(deps, {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-partial-failure",
      }),
    ).rejects.toThrow("Failed to archive one or more workspaces");

    expect((await deps.listActiveWorkspaces()).map((workspace) => workspace.workspaceId)).toEqual([
      workspaceA,
    ]);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("retries persisted physical cleanup after the workspace record is archived", async () => {
    const { tempDir, repoDir } = createGitRepo();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"const fs=require('fs');const marker=process.env.PASEO_SOURCE_CHECKOUT_PATH+'/cleanup-retry.marker';if(!fs.existsSync(marker)){fs.writeFileSync(marker,'retry');process.exit(1)}\"",
          ],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "retry cleanup"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "cleanup-retry");
    const workspaceId = "ws-cleanup-retry";
    const registry = new FileBackedWorkspaceRegistry(
      path.join(tempDir, "workspaces.json"),
      createLogger(),
    );
    await registry.initialize();
    const timestamp = new Date().toISOString();
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-cleanup-retry",
        cwd: worktree.worktreePath,
        kind: "worktree",
        displayName: "Cleanup retry",
        worktreeRoot: worktree.worktreePath,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: repoDir,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const deps = createArchiveDeps({
      paseoHome,
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
    deps.workspaceRegistry = registry;
    const archiveActiveRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string) => {
      await archiveActiveRecord(id);
      await registry.archive(id, new Date().toISOString());
    };

    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-cleanup-retry-first",
      }),
    ).rejects.toThrow("Worktree teardown command failed");
    expect((await registry.get(workspaceId))?.archivedAt).not.toBeNull();
    expect((await registry.get(workspaceId))?.cleanupPending).toMatchObject({
      directoryPath: worktree.worktreePath,
      teardownCwd: worktree.worktreePath,
    });
    expect(existsSync(worktree.worktreePath)).toBe(true);

    const retryResult = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-cleanup-retry-second",
    });
    expect(retryResult.removedDirectory).toBe(true);
    expect(existsSync(worktree.worktreePath)).toBe(false);
    expect((await registry.get(workspaceId))?.cleanupPending).toBeNull();
  });

  test("a replacement incarnation archives before an old cleanup retry without cross-blocking", async () => {
    const { tempDir, repoDir } = createGitRepo();
    writeFileSync(
      path.join(repoDir, "paseo.json"),
      JSON.stringify({ worktree: { teardown: ['node -e "process.exit(1)"'] } }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fail teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const paseoHome = path.join(tempDir, ".paseo");
    const slug = "reused-incarnation";
    const firstWorktree = await createPaseoOwnedWorktree(repoDir, paseoHome, slug);
    const workspaceId = "ws-reused-incarnation-a";
    const registry = new FileBackedWorkspaceRegistry(
      path.join(tempDir, "workspaces.json"),
      createLogger(),
    );
    await registry.initialize();
    const timestamp = new Date().toISOString();
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "project-reused-incarnation",
        cwd: firstWorktree.worktreePath,
        kind: "worktree",
        displayName: "Old incarnation",
        worktreeRoot: firstWorktree.worktreePath,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: repoDir,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId,
          cwd: firstWorktree.worktreePath,
          kind: "worktree",
          worktreeRoot: firstWorktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    deps.workspaceRegistry = registry;
    const archiveActiveRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = async (id: string) => {
      await archiveActiveRecord(id);
      await registry.archive(id, new Date().toISOString());
    };

    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-reused-incarnation-first",
      }),
    ).rejects.toThrow("Worktree teardown command failed");
    expect((await registry.get(workspaceId))?.cleanupPending).not.toBeNull();

    execFileSync("git", ["worktree", "remove", firstWorktree.worktreePath, "--force"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    execFileSync("git", ["branch", "-D", slug], { cwd: repoDir, stdio: "pipe" });
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify({ worktree: { teardown: [] } }));
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "repair teardown"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    const replacementWorktree = await createPaseoOwnedWorktree(repoDir, paseoHome, slug);
    const replacementWorkspaceId = "ws-reused-incarnation-b";
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: replacementWorkspaceId,
        projectId: "project-reused-incarnation",
        cwd: replacementWorktree.worktreePath,
        kind: "worktree",
        displayName: "Replacement incarnation",
        worktreeRoot: replacementWorktree.worktreePath,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: repoDir,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    deps.activeWorkspaces.push({
      workspaceId: replacementWorkspaceId,
      cwd: replacementWorktree.worktreePath,
      kind: "worktree",
      worktreeRoot: replacementWorktree.worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
    });

    const replacementResult = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: replacementWorkspaceId },
      requestId: "req-reused-incarnation-replacement",
    });
    expect(replacementResult.removedDirectory).toBe(true);
    expect(existsSync(replacementWorktree.worktreePath)).toBe(false);
    expect((await registry.get(replacementWorkspaceId))?.cleanupPending).toBeNull();
    expect((await registry.get(workspaceId))?.cleanupPending).not.toBeNull();

    const retryResult = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-reused-incarnation-retry",
    });
    expect(retryResult.removedDirectory).toBe(false);
    expect((await registry.get(workspaceId))?.cleanupPending).toBeNull();
  });

  test("a partial worktree retry preserves every sibling teardown obligation", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "partial-sibling-retry");
    const nestedCwd = path.join(worktree.worktreePath, "packages", "app");
    mkdirSync(nestedCwd, { recursive: true });
    const workspaceA = "ws-partial-retry-a";
    const workspaceB = "ws-partial-retry-b";
    const registry = new FileBackedWorkspaceRegistry(
      path.join(tempDir, "workspaces.json"),
      createLogger(),
    );
    await registry.initialize();
    const timestamp = new Date().toISOString();
    for (const [workspaceId, cwd] of [
      [workspaceA, worktree.worktreePath],
      [workspaceB, nestedCwd],
    ] as const) {
      await registry.upsert(
        createPersistedWorkspaceRecord({
          workspaceId,
          projectId: "project-partial-retry",
          cwd,
          kind: "worktree",
          displayName: workspaceId,
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        {
          workspaceId: workspaceA,
          cwd: worktree.worktreePath,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
        {
          workspaceId: workspaceB,
          cwd: nestedCwd,
          kind: "worktree",
          worktreeRoot: worktree.worktreePath,
          isPaseoOwnedWorktree: true,
          mainRepoRoot: repoDir,
        },
      ],
    });
    deps.workspaceRegistry = registry;
    const archiveActiveRecord = deps.archiveWorkspaceRecord;
    let rejectWorkspaceBOnce = true;
    deps.archiveWorkspaceRecord = async (workspaceId: string) => {
      if (workspaceId === workspaceB && rejectWorkspaceBOnce) {
        rejectWorkspaceBOnce = false;
        throw new Error("registry archive failed once");
      }
      await archiveActiveRecord(workspaceId);
      await registry.archive(workspaceId, new Date().toISOString());
    };

    await expect(
      archiveByScope(deps, {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-partial-retry-first",
      }),
    ).rejects.toThrow("Failed to archive one or more workspaces");
    expect((await registry.get(workspaceA))?.cleanupPending).not.toBeNull();
    expect((await registry.get(workspaceB))?.archivedAt).toBeNull();
    expect(existsSync(worktree.worktreePath)).toBe(true);

    const retry = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-partial-retry-second",
    });

    expect(retry.removedDirectory).toBe(true);
    expect((await registry.get(workspaceA))?.cleanupPending).toBeNull();
    expect((await registry.get(workspaceB))?.cleanupPending).toBeNull();
    expect(existsSync(worktree.worktreePath)).toBe(false);
  });

  test("workspace teardown failure keeps the record active and prevents recursive deletion", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "strict-teardown");
    const workspaceId = "ws-strict-teardown";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.killTerminalsForWorkspace = vi.fn(async () => {
      throw new Error("terminal still owned");
    });
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId },
        requestId: "req-strict-teardown",
      }),
    ).rejects.toThrow("Failed to archive one or more workspaces");

    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("workspace scope with unknown workspace id is a clean no-op", async () => {
    const { tempDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [],
    });
    const originalArchiveWorkspaceRecord = deps.archiveWorkspaceRecord;
    deps.archiveWorkspaceRecord = vi.fn(async (workspaceId: string) => {
      return originalArchiveWorkspaceRecord(workspaceId);
    });

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
    deps.archiveWorkspaceRecord = async (id: string) => {
      await originalArchiveWorkspaceRecord(id);
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
    const liveAgents = [{ id: liveAgentId, workspaceId: targetWorkspaceId }] as ManagedAgent[];
    const storedRecords = [
      { id: targetStoredAgentId, workspaceId: targetWorkspaceId, archivedAt: null },
      { id: otherStoredAgentId, workspaceId: otherWorkspaceId, archivedAt: null },
    ] as StoredAgentRecord[];

    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: targetWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    deps.agentManager = {
      listAgents: () => liveAgents,
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        removeManagedAgentById(liveAgents, agentId);
        return { archivedAt: new Date().toISOString() };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, archivedAt: string) => {
        deps.archivedSnapshotIds.push(agentId);
        const record = findStoredAgentById(storedRecords, agentId);
        if (record) record.archivedAt = archivedAt;
        return {};
      }),
    };
    deps.agentStorage = {
      list: async () => storedRecords,
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
