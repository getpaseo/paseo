import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import pino, { type Logger } from "pino";

import type { SessionOutboundMessage, WorkspaceDescriptorPayload } from "./messages.js";
import {
  buildAgentSessionConfig,
  createPaseoWorktreeWorkflow,
  handlePaseoWorktreeArchiveRequest,
  handlePaseoWorktreeListRequest,
  resolveRepositoryWorktreePath,
  resolveGitCreateBaseBranch,
  runWorktreeSetupInBackground,
  handleCreatePaseoWorktreeRequest,
  handleWorkspaceSetupStatusRequest,
  validateExplicitWorkspaceArchiveTarget,
} from "./worktree-session.js";
import {
  createWorktree as createWorktreePrimitive,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "../utils/worktree.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { TerminalSession } from "../terminal/terminal.js";
import type { ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type { ForgeService } from "../services/forge-service.js";
import { areEquivalentPaths } from "../utils/path.js";
import {
  createPaseoWorktree as createPaseoWorktreeService,
  type CreatePaseoWorktreeFn,
} from "./paseo-worktree-service.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { isPlatform } from "../test-utils/platform.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
  });
}

function createLogger(): Logger {
  const logger = pino({ level: "silent" });
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  return logger;
}

function createProjectRegistryForRoot(rootPath: string): Pick<ProjectRegistry, "get" | "list"> {
  const project = createPersistedProjectRecord({
    projectId: "prj-worktree-test",
    rootPath,
    kind: "git",
    displayName: path.basename(rootPath),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    get: async (projectId) => (projectId === project.projectId ? project : null),
    list: async () => [project],
  };
}

function createWorkspaceRegistryForRecords(
  records: PersistedWorkspaceRecord[] = [],
): Pick<WorkspaceRegistry, "list"> {
  return { list: async () => records };
}

function createWorktreeListService(): Pick<WorkspaceGitService, "listWorktrees"> {
  return { listWorktrees: vi.fn(async () => []) };
}

function createWorkflowForRequestTest(options: {
  paseoHome: string;
  createPaseoWorktree?: CreatePaseoWorktreeFn;
  warmWorkspaceGitData?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  onSetupStarted?: (input: {
    requestCwd: string;
    repoRoot: string;
    workspaceId: string;
    worktree: WorktreeConfig;
    shouldBootstrap: boolean;
  }) => void;
}) {
  return async (input: Parameters<CreatePaseoWorktreeFn>[0]) => {
    const createPaseoWorktree =
      options.createPaseoWorktree ?? createPaseoWorktreeForTest({ paseoHome: options.paseoHome });
    return createPaseoWorktreeWorkflow(
      {
        paseoHome: options.paseoHome,
        createPaseoWorktree,
        warmWorkspaceGitData: options.warmWorkspaceGitData ?? (async () => {}),
        autoNameWorkspaceBranchForFirstAgent: () => {},
        emitWorkspaceUpdateForWorkspaceId: async () => {},
        cacheWorkspaceSetupSnapshot: () => {},
        emit: () => {},
        sessionLogger: createLogger(),
        terminalManager: null,
        archiveWorkspaceRecord: async () => {},
        serviceProxy: null,
        scriptRuntimeStore: null,
        getDaemonTcpPort: null,
        getDaemonTcpHost: null,
        onScriptsChanged: null,
      },
      input,
      { setupContinuation: { kind: "workspace" } },
    ).then((result) => {
      options.onSetupStarted?.({
        requestCwd: input.cwd,
        repoRoot: result.repoRoot,
        workspaceId: result.workspace.workspaceId,
        worktree: result.worktree,
        shouldBootstrap: result.created,
      });
      return result;
    });
  };
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
    defaultCheckoutRefs: ({ changeRequestNumber }) => [
      { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
    ],
    buildPrLocalBranchName: ({ headRef, checkoutTarget }) => {
      const normalized = checkoutTarget.headOwnerLogin?.trim().toLowerCase() ?? "";
      const owner =
        checkoutTarget.isCrossRepository && /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
      return owner ? `${owner}/${headRef}` : headRef;
    },
    supportsCrossRepoCheckoutWithoutRefs: true,
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

function createTerminalManagerStub(options?: {
  createTerminal?: (input: {
    cwd: string;
    name?: string;
    env?: Record<string, string>;
  }) => Promise<TerminalSession>;
}) {
  const terminals: Array<{
    id: string;
    cwd: string;
    name: string | undefined;
    env: Record<string, string> | undefined;
    sent: string[];
  }> = [];

  return {
    terminals,
    manager: {
      registerCwdEnv: vi.fn(),
      createTerminal: vi.fn(
        async (input: { cwd: string; name?: string; env?: Record<string, string> }) => {
          if (options?.createTerminal) {
            return options.createTerminal(input);
          }
          const sent: string[] = [];
          const terminal = {
            id: `terminal-${terminals.length + 1}`,
            name: input.name ?? "Terminal",
            cwd: input.cwd,
            getState: () => ({
              rows: 1,
              cols: 1,
              scrollback: [[{ char: "$" }]],
              grid: [],
              cursor: { row: 0, col: 0 },
            }),
            subscribe: () => () => {},
            onExit: () => () => {},
            onCommandFinished: () => () => {},
            onTitleChange: () => () => {},
            onActivityChange: () => () => {},
            send: (message: { type: string; data: string }) => {
              if (message.type === "input") {
                sent.push(message.data);
              }
            },
            kill: () => {},
            killAndWait: async () => {},
            getSize: () => ({ rows: 1, cols: 1 }),
            getTitle: () => undefined,
            getActivity: () => null,
            setActivity: () => {},
            getExitInfo: () => null,
          } satisfies TerminalSession;
          terminals.push({
            id: terminal.id,
            cwd: input.cwd,
            name: input.name,
            env: input.env,
            sent,
          });
          return terminal;
        },
      ),
      validateTerminalActivityToken: vi.fn(() => "unknown"),
      getTerminals: vi.fn(async () => []),
      getTerminal: vi.fn(() => undefined),
      killTerminal: vi.fn(),
      killTerminalAndWait: vi.fn(async () => {}),
      setTerminalTitle: vi.fn(),
      setTerminalActivity: vi.fn(async () => false),
      getTerminalState: vi.fn(async () => null),
      captureTerminal: vi.fn(async () => ({ lines: [], totalLines: 0 })),
      listDirectories: vi.fn(() => []),
      killAll: vi.fn(),
      subscribeTerminalsChanged: vi.fn(() => () => {}),
      subscribeTerminalActivity: vi.fn(() => () => {}),
      subscribeTerminalWorkspaceContributionChanged: vi.fn(() => () => {}),
    } satisfies TerminalManager,
  };
}

function createWorkspaceDescriptor(input: {
  workspace: PersistedWorkspaceRecord;
  repoDir: string;
}): WorkspaceDescriptorPayload {
  return {
    id: input.workspace.workspaceId,
    projectId: input.workspace.projectId,
    projectDisplayName: path.basename(input.repoDir),
    projectRootPath: input.repoDir,
    workspaceDirectory: input.workspace.cwd,
    workspaceKind: "worktree",
    projectKind: "git",
    name: input.workspace.displayName,
    status: "done",
    activityAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
  };
}

function createPaseoWorktreeForTest(options: {
  paseoHome: string;
  events?: string[];
  project?: PersistedProjectRecord;
}): CreatePaseoWorktreeFn {
  const projects = new Map<string, PersistedProjectRecord>();
  if (options.project) projects.set(options.project.projectId, options.project);
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: options.paseoHome,
    deps: {
      forgeOverrides: { github: createGitHubServiceStub() },
    },
  });
  const projectRegistry: ProjectRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(projects.values()),
    get: async (projectId) => projects.get(projectId) ?? null,
    getOrCreateActiveByRoot: async (allocation) => {
      const existing = Array.from(projects.values()).find(
        (project) =>
          areEquivalentPaths(project.rootPath, allocation.rootPath) && !project.archivedAt,
      );
      if (existing) return existing;
      const project = createPersistedProjectRecord({
        projectId: `prj_test_${projects.size + 1}`,
        rootPath: allocation.rootPath,
        kind: allocation.kind,
        displayName: allocation.displayName,
        createdAt: allocation.timestamp,
        updatedAt: allocation.timestamp,
      });
      projects.set(project.projectId, project);
      return project;
    },
    upsert: async (record) => {
      options.events?.push(`project:${record.projectId}`);
      projects.set(record.projectId, record);
    },
    archive: async (projectId, archivedAt) => {
      const project = projects.get(projectId);
      if (project) projects.set(projectId, { ...project, archivedAt });
    },
    remove: async (projectId) => {
      projects.delete(projectId);
    },
  };
  const workspaceRegistry: WorkspaceRegistry = {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => Array.from(workspaces.values()),
    get: async (workspaceId) => workspaces.get(workspaceId) ?? null,
    update: async (workspaceId, updater) => {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) return null;
      const updated = updater(workspace);
      workspaces.set(workspaceId, updated);
      return updated;
    },
    upsert: async (record) => {
      options.events?.push(`workspace:${record.workspaceId}`);
      workspaces.set(record.workspaceId, record);
    },
    archive: async (workspaceId, archivedAt) => {
      const workspace = workspaces.get(workspaceId);
      if (workspace) workspaces.set(workspaceId, { ...workspace, archivedAt });
    },
    remove: async (workspaceId) => {
      workspaces.delete(workspaceId);
    },
  };
  const workspaceProvisioning = createWorkspaceProvisioningService({
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger: createLogger(),
  });

  return (input, serviceOptions) => {
    if (input.projectId && !projects.has(input.projectId)) {
      projects.set(
        input.projectId,
        createPersistedProjectRecord({
          projectId: input.projectId,
          rootPath: input.cwd,
          kind: "git",
          displayName: path.basename(input.cwd),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    return createPaseoWorktreeService(input, {
      github: createGitHubServiceStub(),
      ...(serviceOptions?.resolveDefaultBranch
        ? { resolveDefaultBranch: serviceOptions.resolveDefaultBranch }
        : {}),
      workspaceGitService,
      workspaceProvisioning,
    });
  };
}

describe("handlePaseoWorktreeListRequest", () => {
  test("lists worktrees through the workspace git service", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const repoRoot = realpathSync.native(process.cwd());
    const workspaceGitService = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: "/tmp/paseo-home/worktrees/repo/feature",
          createdAt: "2026-04-12T00:00:00.000Z",
          branchName: "feature",
          head: "abc123",
        },
      ]),
    };

    await handlePaseoWorktreeListRequest(
      {
        emit: (message) => emitted.push(message),
        paseoHome: "/tmp/paseo-home",
        workspaceGitService: workspaceGitService as unknown as WorkspaceGitService,
        projectRegistry: createProjectRegistryForRoot(repoRoot),
        workspaceRegistry: createWorkspaceRegistryForRecords(),
      },
      {
        type: "paseo_worktree_list_request",
        repoRoot,
        requestId: "request-worktrees",
      },
    );

    expect(workspaceGitService.listWorktrees).toHaveBeenCalledTimes(1);
    expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(repoRoot);
    expect(emitted).toContainEqual({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [
          {
            worktreePath: "/tmp/paseo-home/worktrees/repo/feature",
            createdAt: "2026-04-12T00:00:00.000Z",
            branchName: "feature",
            head: "abc123",
          },
        ],
        error: null,
        requestId: "request-worktrees",
      },
    });
  });

  test("resolves a legacy caller cwd through the registered project", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const repoRoot = realpathSync.native(process.cwd());
    const workspaceGitService = { listWorktrees: vi.fn(async () => []) };

    await handlePaseoWorktreeListRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceGitService: workspaceGitService as unknown as WorkspaceGitService,
        projectRegistry: createProjectRegistryForRoot(repoRoot),
        workspaceRegistry: createWorkspaceRegistryForRecords(),
      },
      {
        type: "paseo_worktree_list_request",
        cwd: repoRoot,
        requestId: "request-unscoped-worktrees",
      },
    );

    expect(workspaceGitService.listWorktrees).toHaveBeenCalledWith(repoRoot);
    expect(emitted).toContainEqual({
      type: "paseo_worktree_list_response",
      payload: {
        worktrees: [],
        error: null,
        requestId: "request-unscoped-worktrees",
      },
    });
  });

  test("lists a pending cleanup placement after Git forgets the worktree", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const worktreePath = path.join(tempDir, "forgotten-worktree");
    mkdirSync(worktreePath, { recursive: true });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-pending-cleanup",
      projectId: "prj-worktree-test",
      cwd: worktreePath,
      kind: "worktree",
      displayName: "forgotten-worktree",
      branch: "feature/forgotten",
      worktreeRoot: worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
      archivedAt: "2026-04-13T00:00:00.000Z",
      archiveCleanupPhase: "ready_to_delete",
    });
    const emitted: SessionOutboundMessage[] = [];

    try {
      await handlePaseoWorktreeListRequest(
        {
          emit: (message) => emitted.push(message),
          workspaceGitService: {
            listWorktrees: vi.fn(async () => []),
          } as unknown as WorkspaceGitService,
          projectRegistry: createProjectRegistryForRoot(repoDir),
          workspaceRegistry: createWorkspaceRegistryForRecords([workspace]),
        },
        {
          type: "paseo_worktree_list_request",
          projectId: "prj-worktree-test",
          requestId: "request-pending-cleanup",
        },
      );

      expect(emitted).toContainEqual({
        type: "paseo_worktree_list_response",
        payload: {
          worktrees: [
            {
              worktreePath,
              createdAt: "2026-04-12T00:00:00.000Z",
              branchName: "feature/forgotten",
              head: null,
            },
          ],
          error: null,
          requestId: "request-pending-cleanup",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRepositoryWorktreePath", () => {
  test("resolves a branch-only archive from the authoritative repository worktree list", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const worktreePath = path.join(tempDir, "branch-only-worktree");
    const listWorktrees = vi.fn(async () => [
      {
        path: worktreePath,
        branchName: "feature/archive-me",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    try {
      await expect(
        resolveRepositoryWorktreePath({ listWorktrees }, repoDir, undefined, "feature/archive-me"),
      ).resolves.toBe(worktreePath);
      expect(listWorktrees).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree-membership",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects a branch-only archive when the branch match is not unique", async () => {
    await expect(
      resolveRepositoryWorktreePath(
        {
          listWorktrees: vi.fn(async () => [
            { path: "/worktree/one", branchName: "duplicate", createdAt: "2026-01-01" },
            { path: "/worktree/two", branchName: "duplicate", createdAt: "2026-01-01" },
          ]),
        },
        "/repo",
        undefined,
        "duplicate",
      ),
    ).rejects.toThrow("does not uniquely identify");
  });

  test("rejects a worktree path from another repository", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const otherPath = path.join(tempDir, "other-repository-worktree");
    mkdirSync(otherPath);

    try {
      await expect(
        resolveRepositoryWorktreePath(
          {
            listWorktrees: vi.fn(async () => [
              {
                path: path.join(tempDir, "known-worktree"),
                branchName: "known",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ]),
          },
          repoDir,
          otherPath,
          undefined,
        ),
      ).rejects.toThrow("not a worktree for the selected repository");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("forces an authoritative repository membership read", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const worktreePath = path.join(tempDir, "known-worktree");
    mkdirSync(worktreePath);
    const listWorktrees = vi.fn(async () => [
      {
        path: worktreePath,
        branchName: "known",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    try {
      await expect(
        resolveRepositoryWorktreePath({ listWorktrees }, repoDir, worktreePath, undefined),
      ).resolves.toBe(worktreePath);
      expect(listWorktrees).toHaveBeenCalledWith(repoDir, {
        force: true,
        reason: "archive-worktree-membership",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("validateExplicitWorkspaceArchiveTarget", () => {
  test("rejects an explicit workspace from another project or worktree path", async () => {
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-explicit",
      projectId: "prj-a",
      cwd: "/worktrees/a",
      kind: "worktree",
      displayName: "a",
      worktreeRoot: "/worktrees/a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const workspaceRegistry = { list: async () => [workspace] };

    await expect(
      validateExplicitWorkspaceArchiveTarget({
        workspaceRegistry,
        workspaceId: workspace.workspaceId,
        projectId: "prj-b",
        worktreePath: workspace.cwd,
      }),
    ).rejects.toThrow("does not identify the selected project and worktree path");
    await expect(
      validateExplicitWorkspaceArchiveTarget({
        workspaceRegistry,
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        worktreePath: "/worktrees/b",
      }),
    ).rejects.toThrow("does not identify the selected project and worktree path");
  });
});

describe("resolveGitCreateBaseBranch", () => {
  test("resolves the default branch through the workspace git service", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const cwd = path.join(repoDir, "packages", "app");
    const workspaceGitService = {
      resolveDefaultBranch: vi.fn().mockResolvedValue("main"),
      getSnapshot: vi.fn(async () => {
        throw new Error("getSnapshot should not be used for default-branch resolution");
      }),
    };

    try {
      await expect(
        resolveGitCreateBaseBranch(cwd, workspaceGitService as unknown as WorkspaceGitService),
      ).resolves.toBe("main");

      expect(workspaceGitService.resolveDefaultBranch).toHaveBeenCalledWith(cwd);
      expect(workspaceGitService.getSnapshot).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("create-agent worktree setup boundary", () => {
  test("agent setup continuation starts setup for the created agent timeline", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const appendedItems: Array<{ name: string; status: string }> = [];
    const liveItems: Array<{ name: string; status: string }> = [];
    const workspaceSetupEvents: SessionOutboundMessage[] = [];

    try {
      const result = await createPaseoWorktreeWorkflow(
        {
          paseoHome,
          createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome }),
          warmWorkspaceGitData: async () => {},
          autoNameWorkspaceBranchForFirstAgent: () => {},
          emitWorkspaceUpdateForWorkspaceId: async () => {},
          cacheWorkspaceSetupSnapshot: () => {},
          emit: (message) => workspaceSetupEvents.push(message),
          sessionLogger: createLogger(),
          terminalManager: null,
          archiveWorkspaceRecord: async () => {},
          serviceProxy: null,
          scriptRuntimeStore: null,
          getDaemonTcpPort: null,
          getDaemonTcpHost: null,
          onScriptsChanged: null,
        },
        {
          cwd: repoDir,
          worktreeSlug: "agent-setup-after-create",
          runSetup: false,
          paseoHome,
        },
        {
          setupContinuation: {
            kind: "agent",
            terminalManager: createTerminalManagerStub().manager,
            appendTimelineItem: async ({ agentId, item }) => {
              expect(agentId).toBe("agent-after-create");
              if (item.type !== "tool_call") {
                throw new Error(`Expected tool call timeline item, got ${item.type}`);
              }
              appendedItems.push({ name: item.name, status: item.status });
              return true;
            },
            emitLiveTimelineItem: async ({ agentId, item }) => {
              expect(agentId).toBe("agent-after-create");
              if (item.type !== "tool_call") {
                throw new Error(`Expected tool call timeline item, got ${item.type}`);
              }
              liveItems.push({ name: item.name, status: item.status });
              return true;
            },
            logger: createLogger(),
          },
        },
      );

      expect(result.setupContinuation?.kind).toBe("agent");
      expect(workspaceSetupEvents).toEqual([]);

      result.setupContinuation?.startAfterAgentCreate({ agentId: "agent-after-create" });

      await vi.waitFor(() => {
        expect(appendedItems).toContainEqual({
          name: "paseo_worktree_setup",
          status: "completed",
        });
      });
      expect(liveItems).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createAgentStorageStub(): Pick<AgentStorage, "list"> {
  return {
    list: async (): Promise<StoredAgentRecord[]> => [],
  };
}

function createArchiveWorkspaceRecordMutator(
  activeWorkspaces: Array<{
    workspaceId: string;
    cwd: string;
    kind: "worktree" | "local_checkout" | "directory";
  }>,
  archivedWorkspaceRecords: string[],
) {
  return async (id: string) => {
    const index = activeWorkspaces.findIndex((workspace) => workspace.workspaceId === id);
    if (index !== -1) {
      archivedWorkspaceRecords.push(id);
      activeWorkspaces.splice(index, 1);
    }
  };
}

function createGitRepo(options?: { paseoConfig?: Record<string, unknown> }) {
  const tempDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "worktree-session-test-")));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  if (options?.paseoConfig) {
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify(options.paseoConfig, null, 2));
  }
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  return { tempDir, repoDir };
}

function createGitHubPrRemoteRepo() {
  const { tempDir, repoDir } = createGitRepo();
  const featureBranch = "feature/review-pr";
  execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "review branch\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "review branch"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  const featureSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: "pipe" })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["branch", "-D", featureBranch], { cwd: repoDir, stdio: "pipe" });

  const remoteDir = path.join(tempDir, "remote.git");
  execFileSync("git", ["clone", "--bare", repoDir, remoteDir], {
    stdio: "pipe",
  });
  execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/123/head", featureSha], {
    stdio: "pipe",
  });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["fetch", "origin"], { cwd: repoDir, stdio: "pipe" });

  return { tempDir, repoDir };
}

describe("runWorktreeSetupInBackground", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("runs setup from an exact workspace subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const sourceWorkspaceCwd = path.join(repoDir, "packages", "app");
    mkdirSync(sourceWorkspaceCwd, { recursive: true });
    writeFileSync(
      path.join(sourceWorkspaceCwd, "paseo.json"),
      JSON.stringify({
        worktree: {
          setup: ["pwd > setup-cwd.txt"],
        },
      }),
    );
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add app setup"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-subdirectory-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-subdirectory-setup",
      runSetup: false,
      paseoHome,
    });
    const workspaceCwd = path.join(createdWorktree.worktreePath, "packages", "app");

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForWorkspaceId: async () => {},
        cacheWorkspaceSetupSnapshot: () => {},
        emit: () => {},
        sessionLogger: createLogger(),
        terminalManager: null,
        archiveWorkspaceRecord: async () => {},
      },
      {
        requestCwd: sourceWorkspaceCwd,
        repoRoot: repoDir,
        workspaceId: "ws-subdirectory-setup",
        worktree: createdWorktree,
        shouldBootstrap: true,
        slug: "feature-subdirectory-setup",
        worktreePath: createdWorktree.worktreePath,
        workspaceCwd,
      },
    );

    expect(existsSync(path.join(workspaceCwd, "setup-cwd.txt"))).toBe(true);
    expect(existsSync(path.join(createdWorktree.worktreePath, "setup-cwd.txt"))).toBe(false);
  });

  test("emits running then completed snapshots for no-setup workspaces without auto-starting scripts", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-no-setup",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-no-setup",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForWorkspaceId,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "42",
        worktree: {
          branchName: "feature-no-setup",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-no-setup",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "42",
      status: "running",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: "42",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });
    expect(snapshots.get("42")).toMatchObject({
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });

    expect(terminalManager.terminals).toHaveLength(0);
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForWorkspaceId).toHaveBeenCalledWith("42");
  });

  test("archives the pending workspace and emits a failed snapshot when setup cannot start", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    writeFileSync(path.join(repoDir, "paseo.json"), "{ invalid json\n");
    execFileSync("git", ["add", "paseo.json"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "broken config"], {
      cwd: repoDir,
      stdio: "pipe",
    });

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "broken-feature",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "broken-feature",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});
    const workspaceId = "ws-broken-feature";

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForWorkspaceId,
        cacheWorkspaceSetupSnapshot: (snapshotWorkspaceId, snapshot) =>
          snapshots.set(snapshotWorkspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId,
        worktree: {
          branchName: "broken-feature",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "broken-feature",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("failed");
    expect(progressMessages[1]?.payload.error).toMatch(
      /Failed to parse paseo\.json at .*paseo\.json/,
    );
    expect(progressMessages[1]?.payload.detail.commands).toEqual([]);
    expect(snapshots.get(workspaceId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/Failed to parse paseo\.json at .*paseo\.json/),
    });
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(emitWorkspaceUpdateForWorkspaceId).toHaveBeenCalledWith(workspaceId);
  });

  // POSIX-only: setup command is hardcoded to sh, printf, and sleep.
  test.skipIf(isPlatform("win32"))(
    "emits running setup snapshots before completed for real setup commands",
    async () => {
      const { tempDir, repoDir } = createGitRepo({
        paseoConfig: {
          worktree: {
            setup: ["sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\""],
          },
        },
      });
      cleanupPaths.push(tempDir);

      const paseoHome = path.join(tempDir, ".paseo");
      const createdWorktree = await createLegacyWorktreeForTest({
        branchName: "feature-running-setup",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "feature-running-setup",
        runSetup: false,
        paseoHome,
      });
      const worktreePath = createdWorktree.worktreePath;
      const emitted: SessionOutboundMessage[] = [];
      const snapshots = new Map<string, unknown>();
      const logger = createLogger();
      const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
      const archiveWorkspaceRecord = vi.fn(async () => {});

      await runWorktreeSetupInBackground(
        {
          paseoHome,
          emitWorkspaceUpdateForWorkspaceId,
          cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
            snapshots.set(workspaceId, snapshot),
          emit: (message) => emitted.push(message),
          sessionLogger: logger,
          terminalManager: null,
          archiveWorkspaceRecord,
        },
        {
          requestCwd: repoDir,
          repoRoot: repoDir,
          workspaceId: "43",
          worktree: {
            branchName: "feature-running-setup",
            worktreePath,
          },
          shouldBootstrap: true,
          slug: "feature-running-setup",
          worktreePath,
        },
      );

      const progressMessages = emitted.filter(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
          message.type === "workspace_setup_progress",
      );
      expect(progressMessages.length).toBeGreaterThan(1);
      expect(progressMessages[0]?.payload).toMatchObject({
        workspaceId: "43",
        status: "running",
        error: null,
        detail: {
          type: "worktree_setup",
          worktreePath,
          branchName: "feature-running-setup",
          log: "",
          commands: [],
        },
      });
      expect(progressMessages.at(-1)?.payload.status).toBe("completed");

      const runningMessages = progressMessages.filter(
        (message) => message.payload.status === "running",
      );
      expect(runningMessages.length).toBeGreaterThan(0);
      expect(
        progressMessages.findIndex((message) => message.payload.status === "running"),
      ).toBeLessThan(
        progressMessages.findIndex((message) => message.payload.status === "completed"),
      );

      const setupOutputMessage = runningMessages.find((message) =>
        message.payload.detail.commands[0]?.log.includes("phase-one"),
      );
      expect(setupOutputMessage?.payload.detail.log).toContain("phase-one");
      expect(setupOutputMessage?.payload.detail.commands[0]).toMatchObject({
        index: 1,
        command: "sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\"",
        log: expect.stringContaining("phase-one"),
        status: "running",
      });

      expect(progressMessages.at(-1)?.payload).toMatchObject({
        workspaceId: "43",
        status: "completed",
        error: null,
        detail: {
          type: "worktree_setup",
          worktreePath,
          branchName: "feature-running-setup",
        },
      });
      expect(progressMessages.at(-1)?.payload.detail.log).toContain("phase-two");
      expect(progressMessages.at(-1)?.payload.detail.commands[0]).toMatchObject({
        index: 1,
        command: "sh -c \"printf 'phase-one\\\\n'; sleep 0.1; printf 'phase-two\\\\n'\"",
        log: expect.stringContaining("phase-two"),
        status: "completed",
        exitCode: 0,
      });
      expect(snapshots.get("43")).toMatchObject({
        status: "completed",
        error: null,
      });
    },
  );

  test("emits completed when reusing an existing worktree without bootstrapping or auto-starting scripts", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["printf 'ran' > setup-ran.txt"],
        },
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const existingWorktree = await createLegacyWorktreeForTest({
      branchName: "reused-worktree",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "reused-worktree",
      runSetup: false,
      paseoHome,
    });

    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForWorkspaceId,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "44",
        worktree: {
          branchName: "reused-worktree",
          worktreePath: existingWorktree.worktreePath,
        },
        shouldBootstrap: false,
        slug: "reused-worktree",
        worktreePath: existingWorktree.worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: "44",
      status: "running",
      error: null,
    });
    expect(progressMessages[1]?.payload).toMatchObject({
      workspaceId: "44",
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath: existingWorktree.worktreePath,
        branchName: "reused-worktree",
        log: "",
        commands: [],
      },
    });
    expect(terminalManager.terminals).toHaveLength(0);
    expect(readFileSync(path.join(existingWorktree.worktreePath, "README.md"), "utf8")).toContain(
      "hello",
    );
    expect(() =>
      readFileSync(path.join(existingWorktree.worktreePath, "setup-ran.txt"), "utf8"),
    ).toThrow();
    expect(snapshots.get("44")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForWorkspaceId).toHaveBeenCalledWith("44");
  });

  test("keeps setup completed without attempting script launch afterward", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-service-failure",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-service-failure",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub({
      createTerminal: async () => {
        throw new Error("terminal spawn failed");
      },
    });
    const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForWorkspaceId,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "45",
        worktree: {
          branchName: "feature-service-failure",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-service-failure",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages[0]?.payload.status).toBe("running");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(progressMessages[1]?.payload.status).toBe("completed");
    expect(progressMessages[1]?.payload.error).toBeNull();
    expect(
      emitted.some(
        (message) =>
          message.type === "workspace_setup_progress" && message.payload.status === "failed",
      ),
    ).toBe(false);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "Failed to spawn worktree scripts after workspace setup completed",
    );
    expect(terminalManager.terminals).toHaveLength(0);
    expect(snapshots.get("45")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForWorkspaceId).toHaveBeenCalledWith("45");
  });

  test("does not auto-start scripts in socket mode", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        scripts: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const createdWorktree = await createLegacyWorktreeForTest({
      branchName: "feature-socket-mode",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "feature-socket-mode",
      runSetup: false,
      paseoHome,
    });
    const worktreePath = createdWorktree.worktreePath;
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map<string, unknown>();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForWorkspaceId = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await runWorktreeSetupInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForWorkspaceId,
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) =>
          snapshots.set(workspaceId, snapshot),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        workspaceId: "46",
        worktree: {
          branchName: "feature-socket-mode",
          worktreePath,
        },
        shouldBootstrap: true,
        slug: "feature-socket-mode",
        worktreePath,
      },
    );

    expect(terminalManager.terminals).toHaveLength(0);
    expect(snapshots.get("46")).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForWorkspaceId).toHaveBeenCalledWith("46");
  });

  test("returns the cached workspace setup snapshot for status requests", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const snapshots = new Map([
      [
        "ws-feature-a",
        {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      ],
    ]);

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: snapshots,
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "ws-feature-a",
        requestId: "req-status",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-status",
        workspaceId: "ws-feature-a",
        snapshot: {
          status: "completed",
          detail: {
            type: "worktree_setup",
            worktreePath: "/repo/.paseo/worktrees/feature-a",
            branchName: "feature-a",
            log: "done",
            commands: [],
          },
          error: null,
        },
      },
    });
  });

  test("returns null when no cached workspace setup snapshot exists", async () => {
    const emitted: SessionOutboundMessage[] = [];

    await handleWorkspaceSetupStatusRequest(
      {
        emit: (message) => emitted.push(message),
        workspaceSetupSnapshots: new Map(),
      },
      {
        type: "workspace_setup_status_request",
        workspaceId: "ws-missing",
        requestId: "req-missing",
      },
    );

    expect(emitted).toContainEqual({
      type: "workspace_setup_status_response",
      payload: {
        requestId: "req-missing",
        workspaceId: "ws-missing",
        snapshot: null,
      },
    });
  });
});

describe("handleCreatePaseoWorktreeRequest", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("checks out the GitHub PR branch when githubPrNumber is supplied", async () => {
    const { tempDir, repoDir } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);

    const emitted: SessionOutboundMessage[] = [];
    const logger = createLogger();
    const paseoHome = path.join(tempDir, ".paseo");
    const project = createPersistedProjectRecord({
      projectId: "prj-worktree-test",
      rootPath: repoDir,
      kind: "git",
      displayName: path.basename(repoDir),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await handleCreatePaseoWorktreeRequest(
      {
        paseoHome,
        describeWorkspaceRecord: async (result) =>
          createWorkspaceDescriptor({ workspace: result.workspace, repoDir }),
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords(),
        workspaceGitService: createWorktreeListService(),
        createPaseoWorktreeWorkflow: createWorkflowForRequestTest({
          paseoHome,
          createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome, project }),
        }),
      },
      {
        type: "create_paseo_worktree_request",
        requestId: "req-pr-worktree",
        cwd: repoDir,
        worktreeSlug: "review-pr-123",
        action: "checkout",
        githubPrNumber: 123,
        refName: "feature/review-pr",
      },
    );

    const response = emitted.find(
      (
        message,
      ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
        message.type === "create_paseo_worktree_response",
    );

    expect(response?.payload.error).toBeNull();
    expect(response?.payload.workspace?.workspaceDirectory).toBeTruthy();

    const worktreePath = response?.payload.workspace?.workspaceDirectory;
    expect(worktreePath).toBeTruthy();
    if (!worktreePath) {
      return;
    }

    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(branch).toBe("feature/review-pr");

    const readme = readFileSync(path.join(worktreePath, "README.md"), "utf8");
    expect(readme).toContain("review branch");
  });

  test("buildAgentSessionConfig checks out the GitHub PR branch for agent worktrees", async () => {
    const { tempDir, repoDir } = createGitHubPrRemoteRepo();
    cleanupPaths.push(tempDir);
    const events: string[] = [];

    const result = await buildAgentSessionConfig(
      {
        paseoHome: path.join(tempDir, ".paseo"),
        sessionLogger: createLogger(),
        workspaceGitService: {
          resolveRepoRoot: vi.fn(async () => repoDir),
          resolveDefaultBranch: vi.fn(async () => "main"),
        } as unknown as WorkspaceGitService,
        createPaseoWorktree: createPaseoWorktreeForTest({
          paseoHome: path.join(tempDir, ".paseo"),
          events,
        }),
        checkoutExistingBranch: async () => {
          throw new Error("should not checkout existing branch");
        },
        createBranchFromBase: async () => {
          throw new Error("should not create a new branch from base");
        },
      },
      {
        provider: "codex",
        cwd: repoDir,
      },
      {
        createWorktree: true,
        worktreeSlug: "agent-review-pr-123",
        action: "checkout",
        githubPrNumber: 123,
        refName: "feature/review-pr",
      },
    );

    expect(result.sessionConfig.cwd).toContain("agent-review-pr-123");
    expect(events.some((event) => event.startsWith("workspace:"))).toBe(true);

    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: result.sessionConfig.cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
    expect(branch).toBe("feature/review-pr");
  });

  test("buildAgentSessionConfig uses the normalized new branch name as the worktree slug fallback", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");

    const result = await buildAgentSessionConfig(
      {
        paseoHome,
        sessionLogger: createLogger(),
        workspaceGitService: {
          resolveRepoRoot: vi.fn(async () => repoDir),
          resolveDefaultBranch: vi.fn(async () => "main"),
        } as unknown as WorkspaceGitService,
        createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome }),
        checkoutExistingBranch: async () => {
          throw new Error("should not checkout existing branch");
        },
        createBranchFromBase: async () => {
          throw new Error("should not create a branch outside the worktree service");
        },
      },
      {
        provider: "codex",
        cwd: repoDir,
      },
      {
        createWorktree: true,
        createNewBranch: true,
        newBranchName: "feature-x",
      },
    );

    expect(path.basename(result.sessionConfig.cwd)).toBe("feature-x");
  });

  test("buildAgentSessionConfig passes prompt and attachment context into worktree creation", async () => {
    const createPaseoWorktree = vi.fn(async () => ({
      worktree: {
        branchName: "fix-attached-pr-context",
        worktreePath: "/tmp/worktrees/fix-attached-pr-context",
      },
      intent: {
        kind: "branch-off" as const,
        baseBranch: "main",
        branchName: "fix-attached-pr-context",
      },
      workspace: {
        workspaceId: "ws-fix-attached-pr-context",
        projectId: "/tmp/repo",
        cwd: "/tmp/worktrees/fix-attached-pr-context/packages/app",
        kind: "worktree" as const,
        displayName: "fix-attached-pr-context",
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z",
        archivedAt: null,
      },
      repoRoot: "/tmp/repo",
      created: true,
    }));
    const firstAgentContext = {
      prompt: "Create a worktree name from this prompt",
      attachments: [
        {
          type: "github_pr" as const,
          mimeType: "application/github-pr",
          number: 123,
          title: "Fix worktree naming",
          url: "https://github.com/getpaseo/paseo/pull/123",
          baseRefName: "main",
          headRefName: "fix/worktree-naming",
        },
      ],
    };

    const result = await buildAgentSessionConfig(
      {
        sessionLogger: createLogger(),
        workspaceGitService: {
          resolveDefaultBranch: vi.fn(async () => "main"),
        } as unknown as WorkspaceGitService,
        createPaseoWorktree,
        checkoutExistingBranch: async () => {
          throw new Error("should not checkout existing branch");
        },
        createBranchFromBase: async () => {
          throw new Error("should not create a branch outside the worktree service");
        },
      },
      {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      {
        createWorktree: true,
        action: "branch-off",
      },
      undefined,
      firstAgentContext,
    );

    expect(createPaseoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        firstAgentContext,
      }),
      expect.anything(),
    );
    expect(result.sessionConfig.cwd).toBe("/tmp/worktrees/fix-attached-pr-context/packages/app");
  });

  test("buildAgentSessionConfig invalidates GitHub cache after branch setup mutations", async () => {
    const invalidate = vi.fn();
    const createBranchFromBase = vi.fn(async () => {});
    const checkoutExistingBranch = vi.fn(async () => ({ source: "local" as const }));
    const createPaseoWorktree = vi.fn(async () => {
      throw new Error("should not create worktree");
    });

    await buildAgentSessionConfig(
      {
        sessionLogger: createLogger(),
        createPaseoWorktree,
        checkoutExistingBranch,
        createBranchFromBase,
        workspaceGitService: { invalidateForge: invalidate } as unknown as WorkspaceGitService,
      },
      {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      {
        createNewBranch: true,
        baseBranch: "main",
        newBranchName: "feature-x",
      },
    );

    expect(createBranchFromBase).toHaveBeenCalledWith({
      cwd: "/tmp/repo",
      baseBranch: "main",
      newBranchName: "feature-x",
    });
    expect(invalidate).toHaveBeenCalledWith("/tmp/repo");

    invalidate.mockClear();

    await buildAgentSessionConfig(
      {
        sessionLogger: createLogger(),
        createPaseoWorktree,
        checkoutExistingBranch,
        createBranchFromBase,
        workspaceGitService: { invalidateForge: invalidate } as unknown as WorkspaceGitService,
      },
      {
        provider: "codex",
        cwd: "/tmp/repo",
      },
      {
        baseBranch: "release",
      },
    );

    expect(checkoutExistingBranch).toHaveBeenCalledWith("/tmp/repo", "release");
    expect(invalidate).toHaveBeenCalledWith("/tmp/repo");
  });

  test("createPaseoWorktreeForTest forwards the default branch resolver for branch-off intents", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const resolveDefaultBranch = vi.fn(async () => "main");

    const result = await createPaseoWorktreeForTest({ paseoHome })(
      {
        cwd: repoDir,
        worktreeSlug: "resolver-feature",
        action: "branch-off",
        runSetup: false,
        paseoHome,
      },
      { resolveDefaultBranch },
    );

    expect(result.intent).toMatchObject({
      kind: "branch-off",
      baseBranch: "main",
      branchName: "resolver-feature",
    });
    const resolvedCwd = resolveDefaultBranch.mock.calls[0]?.[0];
    expect(resolvedCwd).toBeDefined();
    expect(realpathSync.native(resolvedCwd ?? "")).toBe(realpathSync.native(repoDir));
  });
});

describe("handleCreatePaseoWorktreeRequest", () => {
  test("registers a pending workspace and emits a successful create response", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const events: string[] = [];

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          projectRegistry: createProjectRegistryForRoot(repoDir),
          workspaceRegistry: createWorkspaceRegistryForRecords(),
          workspaceGitService: createWorktreeListService(),
          createPaseoWorktreeWorkflow: createWorkflowForRequestTest({
            paseoHome,
            createPaseoWorktree: createPaseoWorktreeForTest({ paseoHome, events }),
          }),
          describeWorkspaceRecord: vi.fn(async (result) => ({
            id: result.workspace.workspaceId,
            projectId: result.workspace.projectId,
            projectDisplayName: path.basename(repoDir),
            projectRootPath: repoDir,
            projectKind: "git",
            workspaceKind: "worktree",
            name: "single-call",
            status: "done",
            activityAt: null,
            diffStat: { additions: 0, deletions: 0 },
            scripts: [],
            gitRuntime: {
              currentBranch: "single-call",
              remoteUrl: null,
              isPaseoOwnedWorktree: true,
              isDirty: false,
              aheadBehind: null,
              aheadOfOrigin: null,
              behindOfOrigin: null,
            },
            githubRuntime: null,
          })),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          repoRoot: repoDir,
          worktreeSlug: "single-call",
          requestId: "req-single-call",
        },
      );

      expect(events.some((event) => event.startsWith("workspace:"))).toBe(true);
      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("creates the worktree before emitting the response", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];
    const backgroundWork = vi.fn(async () => {});
    const warmWorkspaceGitData = vi.fn(async () => {});
    let registeredWorktreePath: string | null = null;

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          projectRegistry: createProjectRegistryForRoot(repoDir),
          workspaceRegistry: createWorkspaceRegistryForRecords(),
          workspaceGitService: createWorktreeListService(),
          createPaseoWorktreeWorkflow: createWorkflowForRequestTest({
            paseoHome,
            createPaseoWorktree: async (input) => {
              const result = await createPaseoWorktreeForTest({ paseoHome })(input);
              expect(existsSync(result.worktree.worktreePath)).toBe(true);
              registeredWorktreePath = result.worktree.worktreePath;
              return result;
            },
            warmWorkspaceGitData,
            onSetupStarted: backgroundWork,
          }),
          describeWorkspaceRecord: vi.fn(async (result) =>
            createWorkspaceDescriptor({ workspace: result.workspace, repoDir }),
          ),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          repoRoot: repoDir,
          worktreeSlug: "response-after-create",
          requestId: "req-1",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.error).toBeNull();
      expect(response?.payload.workspace?.id).toBeTruthy();
      expect(emitted.map((message) => message.type).slice(0, 2)).toEqual([
        "create_paseo_worktree_response",
        "workspace_update",
      ]);
      const workspaceUpdate = emitted[1];
      expect(workspaceUpdate).toMatchObject({
        type: "workspace_update",
        payload: {
          kind: "upsert",
          workspace: response?.payload.workspace,
        },
      });
      expect(registeredWorktreePath).toBeTruthy();
      expect(existsSync(registeredWorktreePath!)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warmWorkspaceGitData).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: response?.payload.workspace?.id,
          cwd: registeredWorktreePath,
        }),
      );
      const backgroundInput = backgroundWork.mock.calls[0]?.[0];
      expect(backgroundInput).toEqual(
        expect.objectContaining({
          requestCwd: repoDir,
          worktree: {
            branchName: "response-after-create",
            worktreePath: registeredWorktreePath,
          },
          shouldBootstrap: true,
        }),
      );
      expect(realpathSync.native(backgroundInput?.repoRoot ?? "")).toBe(
        realpathSync.native(repoDir),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("emits a machine-readable error code for invalid worktree intent", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          projectRegistry: createProjectRegistryForRoot(repoDir),
          workspaceRegistry: createWorkspaceRegistryForRecords(),
          workspaceGitService: createWorktreeListService(),
          createPaseoWorktreeWorkflow: createWorkflowForRequestTest({ paseoHome }),
          describeWorkspaceRecord: vi.fn(async (result) =>
            createWorkspaceDescriptor({ workspace: result.workspace, repoDir }),
          ),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          repoRoot: repoDir,
          action: "checkout",
          requestId: "req-missing-target",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.workspace).toBeNull();
      expect(response?.payload.error).toBe('action "checkout" requires refName or checkoutSource');
      expect(response?.payload.errorCode).toBe("missing_checkout_target");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("emits a machine-readable error code for unknown checkout branches", async () => {
    const { tempDir, repoDir } = createGitRepo();
    const paseoHome = path.join(tempDir, ".paseo");
    const emitted: SessionOutboundMessage[] = [];

    try {
      await handleCreatePaseoWorktreeRequest(
        {
          paseoHome,
          sessionLogger: createLogger(),
          emit: (message) => emitted.push(message),
          projectRegistry: createProjectRegistryForRoot(repoDir),
          workspaceRegistry: createWorkspaceRegistryForRecords(),
          workspaceGitService: createWorktreeListService(),
          createPaseoWorktreeWorkflow: createWorkflowForRequestTest({ paseoHome }),
          describeWorkspaceRecord: vi.fn(async (result) =>
            createWorkspaceDescriptor({ workspace: result.workspace, repoDir }),
          ),
        },
        {
          type: "create_paseo_worktree_request",
          cwd: repoDir,
          repoRoot: repoDir,
          action: "checkout",
          refName: "missing-branch",
          requestId: "req-unknown-branch",
        },
      );

      const response = emitted.find(
        (
          message,
        ): message is Extract<SessionOutboundMessage, { type: "create_paseo_worktree_response" }> =>
          message.type === "create_paseo_worktree_response",
      );
      expect(response?.payload.workspace).toBeNull();
      expect(response?.payload.error).toBe("Unknown branch: missing-branch");
      expect(response?.payload.errorCode).toBe("unknown_branch");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("handlePaseoWorktreeArchiveRequest worktree scope", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("uses the persisted workspace placement when workspaceId is the only selector", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "workspace-id-placement",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "workspace-id-placement",
      runSetup: false,
      paseoHome,
    });
    const workspaceId = "ws-workspace-id-placement";
    const persistedWorkspace = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "prj-worktree-test",
      cwd: created.worktreePath,
      kind: "worktree",
      displayName: "workspace-id-placement",
      branch: "workspace-id-placement",
      worktreeRoot: created.worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const activeWorkspaces = [
      { workspaceId, cwd: created.worktreePath, kind: "worktree" as const },
    ];
    const emitted: SessionOutboundMessage[] = [];
    const listWorktrees = vi.fn(async () => {
      throw new Error("workspaceId must not fall back to legacy Git owner inference");
    });

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees,
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords([persistedWorkspace]),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => ({})),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => workspaceId),
        listActiveWorkspaces: vi.fn(async () => activeWorkspaces),
        archiveWorkspaceRecord: createArchiveWorkspaceRecordMutator(activeWorkspaces, []),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-workspace-id-placement",
        workspaceId,
        scope: "workspace",
      },
    );

    expect(listWorktrees).not.toHaveBeenCalled();
    expect(existsSync(created.worktreePath)).toBe(false);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({ payload: { success: true, error: null } });
  });

  test("runs lifecycle archive for an active explicit workspace whose backing path is missing", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const workspaceId = "ws-active-missing-placement";
    const missingWorkspacePath = path.join(tempDir, "removed-active-workspace");
    const persistedWorkspace = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "prj-worktree-test",
      cwd: missingWorkspacePath,
      kind: "local_checkout",
      displayName: "removed active workspace",
      mainRepoRoot: repoDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const activeWorkspaces = [
      {
        workspaceId,
        cwd: missingWorkspacePath,
        kind: "local_checkout" as const,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: repoDir,
      },
    ];
    const emitted: SessionOutboundMessage[] = [];
    const agentReads = vi.fn(() => []);
    const archivedWorkspaceRecords: string[] = [];
    const archiveWorkspaceRecord = vi.fn(
      createArchiveWorkspaceRecordMutator(activeWorkspaces, archivedWorkspaceRecords),
    );
    const listWorktrees = vi.fn(async () => {
      throw new Error("active workspaceId must not use legacy Git owner inference");
    });

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome: path.join(tempDir, ".paseo"),
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees,
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords([persistedWorkspace]),
        agentManager: {
          listAgents: agentReads,
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => ({})),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => null),
        listActiveWorkspaces: vi.fn(async () => activeWorkspaces),
        archiveWorkspaceRecord,
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-active-missing-placement",
        workspaceId,
        scope: "workspace",
      },
    );

    expect(agentReads).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(activeWorkspaces).toEqual([]);
    expect(archivedWorkspaceRecords).toEqual([workspaceId]);
    expect(listWorktrees).not.toHaveBeenCalled();
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({ payload: { success: true, error: null } });
  });

  test("reports failure and archived agents when workspace record teardown fails", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const workspaceId = "ws-record-teardown-failure";
    const agentId = "agent-record-teardown-failure";
    const persistedWorkspace = createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "prj-worktree-test",
      cwd: repoDir,
      kind: "local_checkout",
      displayName: "record teardown failure",
      mainRepoRoot: repoDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const activeWorkspaces = [
      {
        workspaceId,
        cwd: repoDir,
        kind: "local_checkout" as const,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: repoDir,
      },
    ];
    const archiveAgent = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
    const archiveWorkspaceRecord = vi.fn(async () => {
      throw new Error("forced registry write failure");
    });
    const emitted: SessionOutboundMessage[] = [];

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome: path.join(tempDir, ".paseo"),
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees: vi.fn(async () => []),
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords([persistedWorkspace]),
        agentManager: {
          listAgents: () => [{ id: agentId, workspaceId }] as ManagedAgent[],
          archiveAgent,
          archiveSnapshot: vi.fn(async () => ({})),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => workspaceId),
        listActiveWorkspaces: vi.fn(async () => activeWorkspaces),
        archiveWorkspaceRecord,
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-record-teardown-failure",
        workspaceId,
        repoRoot: repoDir,
        scope: "workspace",
      },
    );

    expect(archiveAgent).toHaveBeenCalledWith(agentId);
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(activeWorkspaces.map((workspace) => workspace.workspaceId)).toEqual([workspaceId]);
    expect(existsSync(repoDir)).toBe(true);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({
      payload: {
        success: false,
        removedAgents: [agentId],
        error: {
          code: "UNKNOWN",
          message: `Failed to archive workspace record: ${workspaceId}`,
        },
      },
    });
  });

  test("retries cleanup after Git forgets an archived Paseo worktree", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          teardown: ['node -e "process.exit(9)"'],
        },
      },
    });
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "partial-archive-retry",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "partial-archive-retry",
      runSetup: false,
      paseoHome,
    });
    const gitFile = readFileSync(path.join(created.worktreePath, ".git"), "utf8").trim();
    rmSync(gitFile.slice("gitdir: ".length), { recursive: true, force: true });

    const archivedWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-partial-archive-retry",
      projectId: "prj-worktree-test",
      cwd: created.worktreePath,
      kind: "worktree",
      displayName: "partial-archive-retry",
      branch: "partial-archive-retry",
      worktreeRoot: created.worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-02T00:00:00.000Z",
      archiveCleanupPhase: "ready_to_delete",
    });
    const emitted: SessionOutboundMessage[] = [];

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees: vi.fn(async () => []),
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords([archivedWorkspace]),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => {
            throw new Error("not expected for empty agent list");
          }),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => null),
        listActiveWorkspaces: vi.fn(async () => []),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-partial-archive-retry",
        repoRoot: repoDir,
        worktreePath: created.worktreePath,
        branchName: "partial-archive-retry",
        scope: "worktree",
      },
    );

    expect(existsSync(created.worktreePath)).toBe(false);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({ payload: { success: true, error: null } });
  });

  test("settles a retry from persisted archived placement after the worktree is gone", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const missingWorktreePath = path.join(tempDir, "removed-worktree");
    const archivedWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-removed-retry",
      projectId: "prj-worktree-test",
      cwd: missingWorktreePath,
      kind: "worktree",
      displayName: "removed retry",
      branch: "removed-retry",
      worktreeRoot: missingWorktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const emitted: SessionOutboundMessage[] = [];
    const listWorktrees = vi.fn(async () => {
      throw new Error("live Git membership must not be read for a completed retry");
    });

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome: path.join(tempDir, ".paseo"),
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees,
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords([archivedWorkspace]),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => ({})),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => null),
        listActiveWorkspaces: vi.fn(async () => []),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-removed-retry",
        worktreePath: missingWorktreePath,
        scope: "worktree",
      },
    );

    expect(listWorktrees).not.toHaveBeenCalled();
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({ payload: { success: true, error: null } });
  });

  test("rejects a forgotten Paseo path associated only with another project", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);
    const paseoHome = path.join(tempDir, ".paseo");
    const worktreePath = path.join(paseoHome, "worktrees", "project-hash", "other-project");
    mkdirSync(worktreePath, { recursive: true });
    const otherProjectWorkspace = createPersistedWorkspaceRecord({
      workspaceId: "ws-other-project",
      projectId: "prj-other",
      cwd: worktreePath,
      kind: "worktree",
      displayName: "other-project",
      worktreeRoot: worktreePath,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repoDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const emitted: SessionOutboundMessage[] = [];

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees: vi.fn(async () => []),
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords([otherProjectWorkspace]),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => null),
        listActiveWorkspaces: vi.fn(async () => []),
        archiveWorkspaceRecord: vi.fn(async () => {}),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-other-project-retry",
        repoRoot: repoDir,
        worktreePath,
        scope: "worktree",
      },
    );

    expect(existsSync(worktreePath)).toBe(true);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({
      payload: {
        success: false,
        error: { message: "worktreePath is not a worktree for the selected repository" },
      },
    });
  });

  test("archives every active workspace on the directory and removes it", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-worktree-scope",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-worktree-scope",
      runSetup: false,
      paseoHome,
    });
    const sharedCwd = created.worktreePath;
    const workspaceA = "ws-worktree-scope-A";
    const workspaceB = "ws-worktree-scope-B";
    const activeWorkspaces = [
      { workspaceId: workspaceA, cwd: sharedCwd, kind: "worktree" as const },
      { workspaceId: workspaceB, cwd: sharedCwd, kind: "worktree" as const },
    ];
    const archivedWorkspaceRecords: string[] = [];
    const listActiveWorkspaces = vi.fn(async () => activeWorkspaces);
    const emitted: SessionOutboundMessage[] = [];

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees: vi.fn(async () => [
            {
              path: sharedCwd,
              branchName: "archive-worktree-scope",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords(),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => {
            throw new Error("not expected for empty agent list");
          }),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async () => workspaceA),
        listActiveWorkspaces,
        archiveWorkspaceRecord: createArchiveWorkspaceRecordMutator(
          activeWorkspaces,
          archivedWorkspaceRecords,
        ),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-worktree-scope",
        worktreePath: sharedCwd,
        scope: "worktree",
      },
    );

    expect(archivedWorkspaceRecords).toContain(workspaceA);
    expect(archivedWorkspaceRecords).toContain(workspaceB);
    expect(existsSync(sharedCwd)).toBe(false);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({
      payload: {
        success: true,
        error: null,
      },
    });
  });

  test("default scope archives a single workspace record and removes the directory on last reference", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-default-scope",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-default-scope",
      runSetup: false,
      paseoHome,
    });
    const workspaceId = "ws-default-scope";
    const activeWorkspaces = [
      { workspaceId, cwd: created.worktreePath, kind: "worktree" as const },
    ];
    const archivedWorkspaceRecords: string[] = [];
    const emitted: SessionOutboundMessage[] = [];

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees: vi.fn(async () => [
            {
              path: created.worktreePath,
              branchName: "archive-default-scope",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords(),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => {
            throw new Error("not expected for empty agent list");
          }),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async (cwd: string) =>
          cwd === created.worktreePath ? workspaceId : null,
        ),
        listActiveWorkspaces: vi.fn(async () => activeWorkspaces),
        archiveWorkspaceRecord: vi.fn(async (id, context) => {
          if (context?.archiveCleanupPhase) return;
          archivedWorkspaceRecords.push(id);
          if (activeWorkspaces[0]?.workspaceId === id) {
            activeWorkspaces.splice(0, 1);
          }
        }),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-default-scope",
        worktreePath: created.worktreePath,
        repoRoot: repoDir,
      },
    );

    expect(archivedWorkspaceRecords).toEqual([workspaceId]);
    expect(existsSync(created.worktreePath)).toBe(false);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({
      payload: {
        success: true,
        error: null,
      },
    });
  });

  test("default scope keeps the directory when a sibling workspace still references it", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-default-scope-sibling",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-default-scope-sibling",
      runSetup: false,
      paseoHome,
    });
    const sharedCwd = created.worktreePath;
    const workspaceA = "ws-default-scope-sibling-A";
    const workspaceB = "ws-default-scope-sibling-B";
    const activeWorkspaces = [
      { workspaceId: workspaceA, cwd: sharedCwd, kind: "worktree" as const },
      { workspaceId: workspaceB, cwd: sharedCwd, kind: "local_checkout" as const },
    ];
    const archivedWorkspaceRecords: string[] = [];
    const emitted: SessionOutboundMessage[] = [];

    await handlePaseoWorktreeArchiveRequest(
      {
        paseoHome,
        github: createGitHubServiceStub(),
        workspaceGitService: {
          getSnapshot: vi.fn(async () => null),
          invalidateWorktreeList: vi.fn(),
          listWorktrees: vi.fn(async () => [
            {
              path: sharedCwd,
              branchName: "archive-default-scope-sibling",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]),
        },
        projectRegistry: createProjectRegistryForRoot(repoDir),
        workspaceRegistry: createWorkspaceRegistryForRecords(),
        agentManager: {
          listAgents: () => [],
          archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
          archiveSnapshot: vi.fn(async () => {
            throw new Error("not expected for empty agent list");
          }),
        },
        agentStorage: createAgentStorageStub(),
        findWorkspaceIdForCwd: vi.fn(async (cwd: string) =>
          cwd === sharedCwd ? workspaceA : null,
        ),
        listActiveWorkspaces: vi.fn(async () => activeWorkspaces),
        archiveWorkspaceRecord: vi.fn(async (id: string) => {
          archivedWorkspaceRecords.push(id);
          if (activeWorkspaces[0]?.workspaceId === id) {
            activeWorkspaces.splice(0, 1);
          }
        }),
        emit: (message) => emitted.push(message),
        emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
        markWorkspaceArchiving: vi.fn(),
        clearWorkspaceArchiving: vi.fn(),
        killTerminalsForWorkspace: vi.fn(async () => {}),
        sessionLogger: createLogger(),
      },
      {
        type: "paseo_worktree_archive_request",
        requestId: "req-default-scope-sibling",
        worktreePath: sharedCwd,
        repoRoot: repoDir,
      },
    );

    expect(archivedWorkspaceRecords).toEqual([workspaceA]);
    expect(existsSync(sharedCwd)).toBe(true);
    expect(
      emitted.find((message) => message.type === "paseo_worktree_archive_response"),
    ).toMatchObject({
      payload: {
        success: true,
        error: null,
      },
    });
  });

  test("ignores deleteWorktreeFromDisk:true and derives directory removal from remaining references", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const created = await createLegacyWorktreeForTest({
      branchName: "archive-delete-flag",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "archive-delete-flag",
      runSetup: false,
      paseoHome,
    });
    const sharedCwd = created.worktreePath;
    const workspaceA = "ws-delete-flag-a";
    const workspaceB = "ws-delete-flag-b";
    const activeWorkspaces = [
      { workspaceId: workspaceA, cwd: sharedCwd, kind: "worktree" as const },
      { workspaceId: workspaceB, cwd: sharedCwd, kind: "worktree" as const },
    ];
    const archivedWorkspaceRecords: string[] = [];
    const emitted: SessionOutboundMessage[] = [];
    const listActiveWorkspaces = vi.fn(async () => activeWorkspaces);
    const persistedWorkspaces = [workspaceA, workspaceB].map((workspaceId) =>
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "prj-worktree-test",
        cwd: sharedCwd,
        kind: "worktree",
        displayName: workspaceId,
        branch: "archive-delete-flag",
        worktreeRoot: sharedCwd,
        isPaseoOwnedWorktree: true,
        mainRepoRoot: repoDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const deps = {
      paseoHome,
      github: createGitHubServiceStub(),
      workspaceGitService: {
        getSnapshot: vi.fn(async () => null),
        invalidateWorktreeList: vi.fn(),
        listWorktrees: vi.fn(async () => [
          {
            path: sharedCwd,
            branchName: "archive-delete-flag",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      },
      projectRegistry: createProjectRegistryForRoot(repoDir),
      workspaceRegistry: createWorkspaceRegistryForRecords(persistedWorkspaces),
      agentManager: {
        listAgents: () => [],
        archiveAgent: vi.fn(async () => ({ archivedAt: new Date().toISOString() })),
        archiveSnapshot: vi.fn(async () => {
          throw new Error("not expected for empty agent list");
        }),
      },
      agentStorage: createAgentStorageStub(),
      findWorkspaceIdForCwd: vi.fn(async (cwd: string) => (cwd === sharedCwd ? workspaceA : null)),
      listActiveWorkspaces,
      archiveWorkspaceRecord: createArchiveWorkspaceRecordMutator(
        activeWorkspaces,
        archivedWorkspaceRecords,
      ),
      emit: (message: SessionOutboundMessage) => emitted.push(message),
      emitWorkspaceUpdatesForWorkspaceIds: vi.fn(async () => {}),
      markWorkspaceArchiving: vi.fn(),
      clearWorkspaceArchiving: vi.fn(),
      killTerminalsForWorkspace: vi.fn(async () => {}),
      sessionLogger: createLogger(),
    };

    // First archive: a sibling workspace still references the directory, so the
    // retained deleteWorktreeFromDisk:true flag must NOT force removal.
    await handlePaseoWorktreeArchiveRequest(deps, {
      type: "paseo_worktree_archive_request",
      requestId: "req-delete-flag-first",
      worktreePath: sharedCwd,
      repoRoot: repoDir,
      workspaceId: workspaceA,
      scope: "workspace",
      deleteWorktreeFromDisk: true,
    });

    expect(archivedWorkspaceRecords).toEqual([workspaceA]);
    expect(activeWorkspaces).toHaveLength(1);
    expect(activeWorkspaces[0]?.workspaceId).toBe(workspaceB);
    expect(existsSync(sharedCwd)).toBe(true);

    archivedWorkspaceRecords.length = 0;

    // Second archive: last reference, so removal is derived even though the flag
    // is still ignored.
    await handlePaseoWorktreeArchiveRequest(deps, {
      type: "paseo_worktree_archive_request",
      requestId: "req-delete-flag-second",
      worktreePath: sharedCwd,
      repoRoot: repoDir,
      workspaceId: workspaceB,
      scope: "workspace",
      deleteWorktreeFromDisk: true,
    });

    expect(archivedWorkspaceRecords).toEqual([workspaceB]);
    expect(existsSync(sharedCwd)).toBe(false);
    expect(
      emitted.filter((message) => message.type === "paseo_worktree_archive_response"),
    ).toHaveLength(2);
  });
});
