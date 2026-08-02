import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ForgeService } from "../services/forge-service.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { createWorktree, type WorktreeConfig } from "../utils/worktree.js";
import { AgentArchiveError, type ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { LifecycleMutationCoordinator } from "./lifecycle-mutation-coordinator.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  type ArchiveDependencies,
  type ArchiveResult,
  resolveWorkspaceIdAtPath,
} from "./workspace-archive-service.js";

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
        return { archivedAt: new Date().toISOString(), archivedAgentIds: [agentId] };
      }),
      archiveSnapshotWithReceipt: vi.fn(async (agentId: string, _archivedAt: string) => {
        archivedSnapshotIds.push(agentId);
        return { record: {} as StoredAgentRecord, archivedAgentIds: [agentId] };
      }),
    },
    agentStorage: {
      list: async (): Promise<StoredAgentRecord[]> => [],
    } as Pick<AgentStorage, "list">,
    lifecycleMutationCoordinator: new LifecycleMutationCoordinator(),
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

  test("continues archiving when terminal teardown fails", async () => {
    const { tempDir } = createGitRepo();
    const workspaceId = "ws-terminal-teardown-failure";
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId, cwd: tempDir, kind: "local_checkout" }],
    });
    const terminalError = new Error("Injected terminal teardown failure");
    deps.killTerminalsForWorkspace = vi.fn(async () => {
      throw terminalError;
    });
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-terminal-teardown-failure",
    });

    expect(result).toEqual({
      archivedAgentIds: [],
      archivedWorkspaceIds: [workspaceId],
      removedDirectory: false,
    });
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(deps.sessionLogger?.warn).toHaveBeenCalledWith(
      { err: terminalError, workspaceId },
      "Workspace archive teardown step failed; continuing",
    );
  });

  test("keeps the workspace active when a stored agent archive rejects", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(repoDir, paseoHome, "stored-agent-failure");
    const workspaceId = "ws-stored-agent-failure";
    const storedAgentId = "agent-stored-failure";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [{ workspaceId, cwd: worktree.worktreePath, kind: "worktree" }],
    });
    deps.agentStorage = {
      list: async () => [
        {
          id: storedAgentId,
          cwd: worktree.worktreePath,
          workspaceId,
          archivedAt: null,
        } as StoredAgentRecord,
      ],
    } as Pick<AgentStorage, "list">;
    deps.agentManager.archiveSnapshotWithReceipt = vi.fn(async () => {
      throw new Error("Injected stored agent archive failure");
    });
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    await expect(
      archiveByScope(deps, {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-stored-agent-failure",
      }),
    ).rejects.toThrow("Injected stored agent archive failure");

    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(deps.activeWorkspaces.map((workspace) => workspace.workspaceId)).toEqual([workspaceId]);
    expect(existsSync(worktree.worktreePath)).toBe(true);
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

    const result = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: worktree.worktreePath },
      requestId: "req-partial-failure",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceB]);
    expect(result.archivedWorkspaceIds).not.toContain(workspaceA);
    expect(result.removedDirectory).toBe(false);
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
        return { archivedAt: new Date().toISOString(), archivedAgentIds: [agentId] };
      }),
      archiveSnapshotWithReceipt: vi.fn(async (agentId: string, _archivedAt: string) => {
        deps.archivedSnapshotIds.push(agentId);
        return { record: {} as StoredAgentRecord, archivedAgentIds: [agentId] };
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

  test("archives a parent and child once through the parent cascade", async () => {
    const { tempDir } = createGitRepo();
    const workspaceId = "ws-parent-child";
    const parentAgentId = "agent-parent";
    const childAgentId = "agent-child";
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId, cwd: tempDir, kind: "local_checkout" }],
    });
    const agents = [
      { id: parentAgentId, cwd: tempDir, workspaceId },
      {
        id: childAgentId,
        cwd: tempDir,
        workspaceId,
        labels: { "paseo.parent-agent-id": parentAgentId },
      },
    ] as ManagedAgent[];
    deps.agentManager = {
      listAgents: () => agents,
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        if (agentId === parentAgentId) {
          deps.archivedAgentIds.push(childAgentId);
        }
        return {
          archivedAt: new Date().toISOString(),
          archivedAgentIds: agentId === parentAgentId ? [parentAgentId, childAgentId] : [agentId],
        };
      }),
      archiveSnapshotWithReceipt: vi.fn(async () => {
        throw new Error("not expected for live agents");
      }),
    };
    deps.agentStorage = {
      list: async () =>
        agents.map((agent) => ({
          id: agent.id,
          cwd: agent.cwd,
          workspaceId: agent.workspaceId,
          archivedAt: null,
          labels: agent.labels,
        })) as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId },
      requestId: "req-parent-child",
    });

    expect(result.archivedWorkspaceIds).toEqual([workspaceId]);
    expect(result.archivedAgentIds).toEqual(expect.arrayContaining([parentAgentId, childAgentId]));
    expect(result.archivedAgentIds).toHaveLength(2);
    expect(deps.agentManager.archiveAgent).toHaveBeenCalledTimes(1);
    expect(deps.agentManager.archiveAgent).toHaveBeenCalledWith(parentAgentId);
    expect(deps.archivedAgentIds).toEqual([parentAgentId, childAgentId]);
  });

  test("archives an alternating-workspace descendant chain once from the target root", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const middleCwd = path.join(tempDir, "middle-workspace");
    mkdirSync(middleCwd);
    const rootWorkspaceId = "ws-alternating-root";
    const middleWorkspaceId = "ws-alternating-middle";
    const grandchildWorkspaceId = "ws-alternating-grandchild";
    const rootAgentId = "agent-alternating-root";
    const middleAgentId = "agent-alternating-middle";
    const grandchildAgentId = "agent-alternating-grandchild";
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [
        { workspaceId: rootWorkspaceId, cwd: repoDir, kind: "local_checkout" },
        { workspaceId: middleWorkspaceId, cwd: middleCwd, kind: "local_checkout" },
        { workspaceId: grandchildWorkspaceId, cwd: repoDir, kind: "local_checkout" },
      ],
    });
    const agents = [
      { id: rootAgentId, cwd: repoDir, workspaceId: rootWorkspaceId },
      {
        id: middleAgentId,
        cwd: middleCwd,
        workspaceId: middleWorkspaceId,
        labels: { "paseo.parent-agent-id": rootAgentId },
      },
      {
        id: grandchildAgentId,
        cwd: repoDir,
        workspaceId: grandchildWorkspaceId,
        labels: { "paseo.parent-agent-id": middleAgentId },
      },
    ] as ManagedAgent[];
    const childrenByParent = new Map([
      [rootAgentId, [middleAgentId]],
      [middleAgentId, [grandchildAgentId]],
    ]);
    const archiveCounts = new Map<string, number>();
    const archiveWithCascade = (agentId: string): string[] => {
      archiveCounts.set(agentId, (archiveCounts.get(agentId) ?? 0) + 1);
      const archivedAgentIds = [agentId];
      for (const childAgentId of childrenByParent.get(agentId) ?? []) {
        archivedAgentIds.push(...archiveWithCascade(childAgentId));
      }
      return archivedAgentIds;
    };
    deps.agentManager = {
      listAgents: () => agents,
      archiveAgent: vi.fn(async (agentId: string) => {
        return {
          archivedAt: new Date().toISOString(),
          archivedAgentIds: archiveWithCascade(agentId),
        };
      }),
      archiveSnapshotWithReceipt: vi.fn(async () => {
        throw new Error("not expected for live agents");
      }),
    };
    deps.agentStorage = {
      list: async () =>
        agents.map((agent) => ({
          id: agent.id,
          cwd: agent.cwd,
          workspaceId: agent.workspaceId,
          archivedAt: null,
          labels: agent.labels,
        })) as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    const result = await archiveByScope(deps, {
      scope: { kind: "worktree", targetPath: repoDir },
      requestId: "req-alternating-workspaces",
    });

    expect(Object.fromEntries(archiveCounts)).toEqual({
      [rootAgentId]: 1,
      [middleAgentId]: 1,
      [grandchildAgentId]: 1,
    });
    expect(deps.agentManager.archiveAgent).toHaveBeenCalledTimes(1);
    expect(deps.agentManager.archiveAgent).toHaveBeenCalledWith(rootAgentId);
    expect(result.archivedAgentIds).toEqual([rootAgentId, middleAgentId, grandchildAgentId]);
    expect(result.archivedWorkspaceIds).toEqual([rootWorkspaceId, grandchildWorkspaceId]);
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledTimes(2);
    expect(deps.killTerminalsForWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.killTerminalsForWorkspace).not.toHaveBeenCalledWith(middleWorkspaceId);
  });

  test("archives only safe target records when an alternating-workspace cascade rejects", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const worktree = await createPaseoOwnedWorktree(
      repoDir,
      paseoHome,
      "alternating-workspace-failure",
    );
    const middleCwd = path.join(tempDir, "middle-workspace-failure");
    mkdirSync(middleCwd);
    const rootWorkspaceId = "ws-failing-root";
    const middleWorkspaceId = "ws-failing-middle";
    const grandchildWorkspaceId = "ws-failing-grandchild";
    const rootAgentId = "agent-failing-root";
    const middleAgentId = "agent-failing-middle";
    const grandchildAgentId = "agent-failing-grandchild";
    const deps = createArchiveDeps({
      paseoHome,
      activeWorkspaces: [
        { workspaceId: rootWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
        { workspaceId: middleWorkspaceId, cwd: middleCwd, kind: "local_checkout" },
        { workspaceId: grandchildWorkspaceId, cwd: worktree.worktreePath, kind: "worktree" },
      ],
    });
    const agents = [
      { id: rootAgentId, cwd: worktree.worktreePath, workspaceId: rootWorkspaceId },
      {
        id: middleAgentId,
        cwd: middleCwd,
        workspaceId: middleWorkspaceId,
        labels: { "paseo.parent-agent-id": rootAgentId },
      },
      {
        id: grandchildAgentId,
        cwd: worktree.worktreePath,
        workspaceId: grandchildWorkspaceId,
        labels: { "paseo.parent-agent-id": middleAgentId },
      },
    ] as ManagedAgent[];
    deps.agentManager = {
      listAgents: () => agents,
      archiveAgent: vi.fn(async (agentId: string) => {
        expect(agentId).toBe(rootAgentId);
        throw new AgentArchiveError({
          archivedAgentIds: [rootAgentId, middleAgentId],
          failedAgentIds: [grandchildAgentId],
          cause: new Error(`Injected archive failure for ${grandchildAgentId}`),
        });
      }),
      archiveSnapshotWithReceipt: vi.fn(async () => {
        throw new Error("not expected for live agents");
      }),
    };
    deps.agentStorage = {
      list: async () =>
        agents.map((agent) => ({
          id: agent.id,
          cwd: agent.cwd,
          workspaceId: agent.workspaceId,
          archivedAt: null,
          labels: agent.labels,
        })) as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    let archiveError: unknown;
    try {
      await archiveByScope(deps, {
        scope: { kind: "worktree", targetPath: worktree.worktreePath },
        requestId: "req-alternating-workspace-failure",
      });
    } catch (error) {
      archiveError = error;
    }

    expect(archiveError).toBeInstanceOf(AgentArchiveError);
    expect(archiveError).toMatchObject({
      archivedAgentIds: [rootAgentId, middleAgentId],
      failedAgentIds: [grandchildAgentId],
    });
    expect(deps.agentManager.archiveAgent).toHaveBeenCalledOnce();
    expect(deps.agentManager.archiveAgent).toHaveBeenCalledWith(rootAgentId);
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledOnce();
    expect(deps.archiveWorkspaceRecord).toHaveBeenCalledWith(rootWorkspaceId);
    expect(deps.killTerminalsForWorkspace).toHaveBeenCalledOnce();
    expect(deps.killTerminalsForWorkspace).toHaveBeenCalledWith(rootWorkspaceId);
    expect(deps.activeWorkspaces.map((workspace) => workspace.workspaceId)).toEqual([
      middleWorkspaceId,
      grandchildWorkspaceId,
    ]);
    expect(existsSync(worktree.worktreePath)).toBe(true);
  });

  test("does not archive the root when a late descendant adds an uncovered workspace", async () => {
    const { tempDir } = createGitRepo();
    const targetWorkspaceId = "ws-late-root";
    const descendantWorkspaceId = "ws-late-descendant";
    const rootAgentId = "agent-late-root";
    const storedRecords = [
      {
        id: rootAgentId,
        cwd: tempDir,
        workspaceId: targetWorkspaceId,
        archivedAt: null,
      },
    ] as StoredAgentRecord[];
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId: targetWorkspaceId, cwd: tempDir, kind: "local_checkout" }],
    });
    deps.agentStorage = {
      list: async () => storedRecords,
    } as Pick<AgentStorage, "list">;
    const listActiveWorkspaces = deps.listActiveWorkspaces;
    let activeWorkspaceReadCount = 0;
    deps.listActiveWorkspaces = async () => {
      activeWorkspaceReadCount += 1;
      if (activeWorkspaceReadCount === 2) {
        storedRecords.push({
          id: "agent-late-descendant",
          cwd: tempDir,
          workspaceId: descendantWorkspaceId,
          archivedAt: null,
          labels: { "paseo.parent-agent-id": rootAgentId },
        } as StoredAgentRecord);
      }
      return await listActiveWorkspaces();
    };
    deps.archiveWorkspaceRecord = vi.fn(deps.archiveWorkspaceRecord);

    await expect(
      archiveByScope(deps, {
        scope: { kind: "workspace", workspaceId: targetWorkspaceId },
        requestId: "req-late-descendant",
      }),
    ).rejects.toThrow("Workspace archive scope changed before mutation");

    expect(deps.archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(deps.activeWorkspaces.map((workspace) => workspace.workspaceId)).toEqual([
      targetWorkspaceId,
    ]);
  });

  test("preflights an archived descendant workspace when that descendant is live again", async () => {
    const { tempDir } = createGitRepo();
    const targetWorkspaceId = "ws-reactivated-root";
    const descendantWorkspaceId = "ws-reactivated-descendant";
    const rootAgentId = "agent-reactivated-root";
    const descendantAgentId = "agent-reactivated-descendant";
    const deps = createArchiveDeps({
      paseoHome: path.join(tempDir, ".paseo"),
      activeWorkspaces: [{ workspaceId: targetWorkspaceId, cwd: tempDir, kind: "local_checkout" }],
    });
    deps.agentStorage = {
      list: async () =>
        [
          {
            id: rootAgentId,
            cwd: tempDir,
            workspaceId: targetWorkspaceId,
            archivedAt: null,
          },
          {
            id: descendantAgentId,
            cwd: tempDir,
            workspaceId: descendantWorkspaceId,
            archivedAt: "2026-01-01T00:00:00.000Z",
            labels: { "paseo.parent-agent-id": rootAgentId },
          },
        ] as StoredAgentRecord[],
    } as Pick<AgentStorage, "list">;
    const archiveReactivatedDescendant = async () => {
      deps.archivedAgentIds.push(descendantAgentId);
    };
    deps.agentManager = {
      listAgents: () =>
        [
          { id: rootAgentId, cwd: tempDir, workspaceId: targetWorkspaceId },
          {
            id: descendantAgentId,
            cwd: tempDir,
            workspaceId: descendantWorkspaceId,
            labels: { "paseo.parent-agent-id": rootAgentId },
          },
        ] as ManagedAgent[],
      archiveAgent: vi.fn(async (agentId: string) => {
        deps.archivedAgentIds.push(agentId);
        if (agentId === rootAgentId) {
          await deps.lifecycleMutationCoordinator.run(
            { workspaceIds: [descendantWorkspaceId] },
            archiveReactivatedDescendant,
          );
        }
        return {
          archivedAt: new Date().toISOString(),
          archivedAgentIds: agentId === rootAgentId ? [rootAgentId, descendantAgentId] : [agentId],
        };
      }),
      archiveSnapshotWithReceipt: vi.fn(async () => {
        throw new Error("not expected for live agents");
      }),
    };

    const result = await archiveByScope(deps, {
      scope: { kind: "workspace", workspaceId: targetWorkspaceId },
      requestId: "req-reactivated-descendant",
    });

    expect(result.archivedWorkspaceIds).toEqual([targetWorkspaceId]);
    expect(deps.archivedAgentIds).toEqual([rootAgentId, descendantAgentId]);
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
