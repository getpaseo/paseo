import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";
import { WorkspaceLifecycleCoordinator } from "../../workspace-lifecycle-coordinator.js";

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
      setupContinuation: {
        kind: "agent" as const,
        startAfterAgentCreate: () => {},
        releaseWithoutStarting: () => {},
      },
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("session create persists and arms auto-archive before starting the initial prompt", async () => {
  const order: string[] = [];
  const snapshot = {
    id: "agent-auto-archive-gap",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async (_config, _agentId, options) => {
    expect(options.autoArchiveObligation).toEqual({
      phase: "armed",
      target: { kind: "agent" },
    });
    order.push("persisted");
    return snapshot;
  });
  const streamAgent = vi.fn(() => {
    order.push("prompt");
    return (async function* noop() {})();
  });

  await createAgentCommand(
    {
      agentManager: {
        createAgent,
        getAgent: vi.fn(() => snapshot),
        tryRunOutOfBand: vi.fn(() => false),
        hasInFlightRun: vi.fn(() => false),
        streamAgent,
        waitForAgentRunStart: vi.fn(async () => undefined),
      } as unknown as AgentManager,
      agentStorage: {} as AgentStorage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
      workspaceId: "ws-create-test",
      initialPrompt: "finish immediately",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: {},
      autoArchiveObligation: { phase: "armed", target: { kind: "agent" } },
      onCreated: () => order.push("armed"),
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    },
  );

  expect(order).toEqual(["persisted", "armed", "prompt"]);
});

test("session create reports a durable agent when initial prompt start is not confirmed", async () => {
  const agentId = "00000000-0000-4000-8000-000000000401";
  const promptStartTimeout = new Error("initial prompt start timed out");
  const snapshot = {
    id: agentId,
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const liveSnapshot = { ...snapshot, lifecycle: "running" as const };
  const removePendingAgentCreation = vi.fn(async () => undefined);
  const onCreated = vi.fn();

  const result = await createAgentCommand(
    {
      agentManager: {
        createAgent: vi.fn(async () => snapshot),
        getAgent: vi.fn(() => liveSnapshot),
        tryRunOutOfBand: vi.fn(() => false),
        hasInFlightRun: vi.fn(() => false),
        streamAgent: vi.fn(() => (async function* noop() {})()),
        waitForAgentRunStart: vi.fn(async () => {
          throw promptStartTimeout;
        }),
      } as unknown as AgentManager,
      agentStorage: {
        removePendingAgentCreation,
      } as unknown as AgentStorage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    },
    {
      kind: "session",
      agentId,
      config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
      workspaceId: "ws-create-test",
      initialPrompt: "start the work",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: {},
      autoArchiveObligation: { phase: "armed", target: { kind: "agent" } },
      onCreated,
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    },
  );

  expect(result).toMatchObject({
    snapshot,
    liveSnapshot,
    initialPromptStarted: false,
    initialPromptError: promptStartTimeout,
  });
  expect(removePendingAgentCreation).toHaveBeenCalledWith(agentId);
  expect(onCreated).toHaveBeenCalledWith({
    agentId,
    autoArchiveObligation: { phase: "armed", target: { kind: "agent" } },
  });
});

test("legacy worktree create keeps its journal through durable agent registration", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-journal-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const agentId = agentManager.allocateAgentId();
  const resolvedWorktreePath = join(workdir, "worktrees", "feature-2");
  const removalOrder: string[] = [];
  const removePendingAgentCreation = storage.removePendingAgentCreation.bind(storage);

  try {
    await storage.beginPendingAgentCreation(agentId);
    vi.spyOn(storage, "removePendingAgentCreation").mockImplementation(async (removingAgentId) => {
      expect(removingAgentId).toBe(agentId);
      expect(await storage.get(agentId)).toMatchObject({
        id: agentId,
        autoArchiveObligation: {
          phase: "armed",
          target: { kind: "workspace", workspaceId: "ws-created-worktree" },
        },
      });
      removalOrder.push("registered");
      await removePendingAgentCreation(removingAgentId);
    });

    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        agentId,
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        autoArchiveObligation: { phase: "armed", target: { kind: "agent" } },
        buildSessionConfig: async (config, _git, _worktreeName, _context, onPath) => {
          await onPath?.(resolvedWorktreePath, {
            worktreeIncarnationId: "30704df3-6339-4c9c-8277-1416544ed7cc",
            directoryIdentity: { device: "7", inode: "42" },
            metadataBaseRefName: "main",
          });
          expect(await storage.listPendingAgentCreations()).toEqual([
            expect.objectContaining({
              agentId,
              cleanupTarget: {
                kind: "worktree",
                targetPath: resolvedWorktreePath,
                worktreeIncarnationId: "30704df3-6339-4c9c-8277-1416544ed7cc",
                directoryIdentity: { device: "7", inode: "42" },
                metadataBaseRefName: "main",
              },
            }),
          ]);
          removalOrder.push("worktree-resolved");
          mkdirSync(resolvedWorktreePath, { recursive: true });
          return {
            sessionConfig: { ...config, cwd: resolvedWorktreePath },
            setupContinuation: {
              kind: "agent",
              startAfterAgentCreate: () => undefined,
              releaseWithoutStarting: () => undefined,
            },
            createdWorkspaceId: "ws-created-worktree",
          };
        },
      },
    );

    expect(snapshot.id).toBe(agentId);
    expect(removalOrder).toEqual(["worktree-resolved", "registered"]);
    await expect(storage.listPendingAgentCreations()).resolves.toEqual([]);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test.each([
  ["validation failure", new Error("invalid provider mode")],
  [
    "validation abort",
    Object.assign(new Error("provider resolution aborted"), { name: "AbortError" }),
  ],
])("session create releases setup reservation after %s", async (_caseName, failure) => {
  const releaseWithoutStarting = vi.fn();
  const startAfterAgentCreate = vi.fn();
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(failure);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test" },
      workspaceId: "ws-source",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({
        sessionConfig: config,
        setupContinuation: {
          kind: "agent",
          startAfterAgentCreate,
          releaseWithoutStarting,
        },
        createdWorkspaceId: "ws-created",
      }),
    }),
  ).rejects.toThrow(failure.message);

  expect(releaseWithoutStarting).toHaveBeenCalledOnce();
  expect(startAfterAgentCreate).not.toHaveBeenCalled();
});

test("session create releases setup reservation when agent creation fails", async () => {
  const releaseWithoutStarting = vi.fn();
  const startAfterAgentCreate = vi.fn();
  const createFailure = new Error("agent creation failed");
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => {
        throw createFailure;
      }),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
      workspaceId: "ws-source",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({
        sessionConfig: config,
        setupContinuation: {
          kind: "agent",
          startAfterAgentCreate,
          releaseWithoutStarting,
        },
        createdWorkspaceId: "ws-created",
      }),
    }),
  ).rejects.toThrow(createFailure.message);

  expect(releaseWithoutStarting).toHaveBeenCalledOnce();
  expect(startAfterAgentCreate).not.toHaveBeenCalled();
});

test.each(["worktree callback", "provider resolution"] as const)(
  "MCP create releases a reserved setup continuation after %s fails",
  async (failurePoint) => {
    const releaseWithoutStarting = vi.fn();
    const startAfterAgentCreate = vi.fn();
    const createAgent = vi.fn();
    const providerSnapshotManager = createProviderSnapshotManagerStub();
    if (failurePoint === "provider resolution") {
      providerSnapshotManager.resolveCreateConfig.mockRejectedValue(
        new Error("provider resolution failed"),
      );
    }
    const createdWorktree = {
      worktree: { worktreePath: "/tmp/paseo-mcp-create/worktree" },
      intent: {},
      workspace: {
        workspaceId: "ws-mcp-created",
        cwd: "/tmp/paseo-mcp-create/worktree",
      },
      repoRoot: "/tmp/paseo-mcp-create",
      created: true,
      setupContinuation: {
        kind: "agent" as const,
        startAfterAgentCreate,
        releaseWithoutStarting,
      },
    } as unknown as CreatePaseoWorktreeWorkflowResult;

    await expect(
      createAgentCommand(
        {
          agentManager: { createAgent } as unknown as AgentManager,
          agentStorage: {} as AgentStorage,
          logger,
          providerSnapshotManager: providerSnapshotManager.manager,
          createPaseoWorktree: vi.fn(async () => createdWorktree),
        },
        {
          kind: "mcp",
          provider: "opencode/test-model",
          title: "MCP worktree child",
          initialPrompt: "do the work",
          background: true,
          notifyOnFinish: false,
          worktree: { worktreeName: "worktree", baseBranch: "main" },
          ...(failurePoint === "worktree callback"
            ? {
                onWorktreeCreated: () => {
                  throw new Error("worktree callback failed");
                },
              }
            : {}),
        },
      ),
    ).rejects.toThrow(failurePoint === "worktree callback" ? "callback" : "provider resolution");

    expect(releaseWithoutStarting).toHaveBeenCalledOnce();
    expect(startAfterAgentCreate).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  },
);

test("agent creation holds workspace ownership until the agent is attached", async () => {
  const lifecycleCoordinator = new WorkspaceLifecycleCoordinator();
  let releaseCreate: (() => void) | undefined;
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const snapshot = {
    id: "agent-owned",
    provider: "codex",
    cwd: "/tmp/paseo-create-owned",
    workspaceId: "ws-owned",
    runtimeInfo: null,
  } as ManagedAgent;
  const createTask = createAgentCommand(
    {
      agentManager: {
        createAgent: vi.fn(async () => {
          markCreateStarted?.();
          await createGate;
          return snapshot;
        }),
      } as unknown as AgentManager,
      agentStorage: {} as AgentStorage,
      logger,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      lifecycleCoordinator,
    },
    {
      kind: "session",
      config: { provider: "codex", cwd: snapshot.cwd },
      workspaceId: "ws-owned",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: {},
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    },
  );

  await createStarted;
  const archiveReservation = lifecycleCoordinator.reserveWorkspaceArchive(["ws-owned"]);
  let ownershipReleased = false;
  const waitTask = lifecycleCoordinator
    .waitForWorkspaceOwnershipMutations(["ws-owned"])
    .then(() => {
      ownershipReleased = true;
      return undefined;
    });
  await Promise.resolve();
  expect(ownershipReleased).toBe(false);

  releaseCreate?.();
  await createTask;
  await waitTask;
  expect(ownershipReleased).toBe(true);
  archiveReservation.release();
});

test("agent creation rejects an ownership attach after workspace archive", async () => {
  const createAgent = vi.fn();
  const requireActiveWorkspaceForOwnership = vi.fn(async () => {
    throw new Error("Workspace not found: ws-archived");
  });

  await expect(
    createAgentCommand(
      {
        agentManager: { createAgent } as unknown as AgentManager,
        agentStorage: {} as AgentStorage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        lifecycleCoordinator: new WorkspaceLifecycleCoordinator(),
        requireActiveWorkspaceForOwnership,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: "/tmp/paseo-create-archived" },
        workspaceId: "ws-archived",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: {},
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    ),
  ).rejects.toThrow("Workspace not found: ws-archived");

  expect(requireActiveWorkspaceForOwnership).toHaveBeenCalledWith("ws-archived");
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: {
            kind: "agent",
            startAfterAgentCreate: () => {},
            releaseWithoutStarting: () => {},
          },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
