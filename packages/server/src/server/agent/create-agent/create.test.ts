import { randomUUID } from "node:crypto";
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

const logger = createTestLogger();

function createRealAgentManager(storage: AgentStorage): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
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
      setupContinuation: { kind: "agent" as const, startAfterAgentCreate: () => {} },
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
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
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
          setupContinuation: { kind: "agent", startAfterAgentCreate: () => {} },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
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
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
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
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
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
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
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
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create archives the agent when the initial prompt fails to start", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-failed-startup-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentId = randomUUID();
  const clients = createTestAgentClients({
    onStartTurn: (prompt) => {
      if (typeof prompt === "string" && prompt === "trigger opencode startup failure") {
        throw new Error("OpenCode event stream first record");
      }
    },
  });
  const agentManager = new AgentManager({
    clients,
    registry: storage,
    logger,
    idFactory: () => agentId,
  });
  const archiveAgent = vi.spyOn(agentManager, "archiveAgent");

  try {
    await expect(
      createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
        },
        {
          kind: "session",
          config: { provider: "opencode", cwd: workdir },
          workspaceId: "ws-failed-startup",
          initialPrompt: "trigger opencode startup failure",
          labels: {},
          provisionalTitle: null,
          firstAgentContext: { attachments: [] },
          buildSessionConfig: async (config) => ({ sessionConfig: config }),
        },
      ),
    ).rejects.toThrow("OpenCode event stream first record");

    expect(archiveAgent).toHaveBeenCalledWith(agentId);
    expect(agentManager.getAgent(agentId)).toBeNull();
    const record = await storage.get(agentId);
    expect(record?.archivedAt).toBeDefined();
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create does not archive the agent when the initial prompt starts", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-success-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentId = randomUUID();
  const agentManager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
    idFactory: () => agentId,
  });
  const archiveAgent = vi.spyOn(agentManager, "archiveAgent");

  try {
    const { snapshot, initialPromptStarted } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "opencode", cwd: workdir },
        workspaceId: "ws-success",
        initialPrompt: "hello",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    expect(snapshot.id).toBe(agentId);
    expect(initialPromptStarted).toBe(true);
    expect(archiveAgent).not.toHaveBeenCalled();
    expect(agentManager.getAgent(agentId)).not.toBeNull();
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create with promptFailure return-error returns the initial prompt error without archiving", async () => {
  const startupError = new Error("OpenCode event stream first record");
  const snapshot = {
    id: "agent-2",
    provider: "opencode",
    cwd: "/tmp",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const archiveAgent = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
  const streamAgent = vi.fn(() => {
    throw startupError;
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
      archiveAgent,
      streamAgent,
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  const result = await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "opencode",
    title: "test",
    cwd: "/tmp",
    workspaceId: "ws-return-error",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
    promptFailure: "return-error",
  });

  expect(result.initialPromptStarted).toBe(false);
  expect(result.initialPromptError).toBe(startupError);
  expect(archiveAgent).not.toHaveBeenCalled();
});

test("mcp create with promptFailure log does not archive the agent", async () => {
  const startupError = new Error("OpenCode event stream first record");
  const snapshot = {
    id: "agent-3",
    provider: "opencode",
    cwd: "/tmp",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const archiveAgent = vi.fn(async () => ({ archivedAt: new Date().toISOString() }));
  const streamAgent = vi.fn(() => {
    throw startupError;
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
      archiveAgent,
      streamAgent,
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  const result = await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "opencode",
    title: "test",
    cwd: "/tmp",
    workspaceId: "ws-log",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
    promptFailure: "log",
  });

  expect(result.initialPromptStarted).toBe(false);
  expect(result.initialPromptError).toBeNull();
  expect(archiveAgent).not.toHaveBeenCalled();
});

test("initial prompt failure still throws the original error when archive fails", async () => {
  const startupError = new Error("OpenCode event stream first record");
  const snapshot = {
    id: "agent-4",
    provider: "opencode",
    cwd: "/tmp",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const archiveAgent = vi.fn(async () => {
    throw new Error("archive failed");
  });
  const streamAgent = vi.fn(() => {
    throw startupError;
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
      archiveAgent,
      streamAgent,
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp" },
      workspaceId: "ws",
      initialPrompt: "hello",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("OpenCode event stream first record");

  expect(archiveAgent).toHaveBeenCalledWith("agent-4");
});
