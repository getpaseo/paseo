import { ProfileRoutingUnavailableError } from "../../system-one/profile-routing.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { PluginRuntime } from "../../plugins/runtime.js";
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
    pluginLifecycle: new PluginRuntime(logger, "0.9.1"),
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

test.each(["session", "mcp human", "mcp delegated", "session unavailable"] as const)(
  "%s create routes the task before runtime creation and clears unsupported effort",
  async (kind) => {
    const snapshot = {
      id: "agent-1",
      provider: "claude",
      cwd: "/private-project",
      workspaceId: "workspace",
      runtimeInfo: null,
    } as ManagedAgent;
    const createAgent = vi.fn(async () => snapshot);
    const unavailable = kind === "session unavailable";
    const createRouter = vi.fn(async () => {
      if (unavailable)
        throw new ProfileRoutingUnavailableError("Quota cooldown", "2026-09-30T13:00:00Z");
      return {
        provider: "claude",
        model: "claude-sonnet-5-5",
        thinkingOptionId: undefined,
      };
    });
    const stub = createProviderSnapshotManagerStub();
    const dependencies: Parameters<typeof createAgentCommand>[0] = {
      agentManager: {
        createAgent,
        getAgent: vi.fn(() => snapshot),
        tryRunOutOfBand: vi.fn(() => false),
        hasInFlightRun: vi.fn(() => false),
        streamAgent: vi.fn(() => (async function* noop() {})()),
        waitForAgentRunStart: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
      agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
      providerSnapshotManager: stub.manager,
      logger,
      createRouter,
    };
    const config = {
      provider: "codex",
      cwd: "/private-project",
      model: "gpt-6.1-sol",
      thinkingOptionId: "xhigh",
      modeId: "codex-only-mode",
    };
    await createAgentCommand(
      dependencies,
      kind === "session" || unavailable
        ? {
            kind: "session",
            config,
            workspaceId: "workspace",
            initialPrompt: "Implement the task",
            labels: { "pandaos.routing.mode": "auto" },
            provisionalTitle: null,
            firstAgentContext: { attachments: [] },
            buildSessionConfig: async (value) => ({ sessionConfig: value }),
          }
        : {
            kind: "mcp",
            provider: "codex/gpt-6.1-sol",
            config,
            cwd: "/private-project",
            workspaceId: "workspace",
            title: "Task",
            initialPrompt: "Implement the task",
            background: true,
            notifyOnFinish: false,
            labels: { "pandaos.routing.mode": "auto" },
            ...(kind === "mcp delegated" ? { callerAgentId: "parent" } : {}),
          },
    );
    expect(createRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Implement the task",
        requestedProvider: "codex",
        requestedThinking: "xhigh",
        isAgentScoped: kind === "mcp delegated",
      }),
    );
    expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: unavailable ? "codex" : "claude",
        requestedMode: unavailable ? "codex-only-mode" : undefined,
      }),
    );
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: unavailable ? "codex" : "claude",
        model: unavailable ? "gpt-6.1-sol" : "claude-sonnet-5-5",
        thinkingOptionId: unavailable ? "xhigh" : undefined,
        modeId: undefined,
      }),
      undefined,
      expect.any(Object),
    );
  },
);

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

test.each([
  ["session", "selected"],
  ["session", "unverified"],
  ["mcp delegated", "selected"],
  ["mcp delegated", "unverified"],
] as const)(
  "%s creation keeps its %s route preflight through real plugin validation and the first turn",
  async (kind, status) => {
    const workdir = mkdtempSync(join(tmpdir(), "create-agent-routing-notice-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const agentManager = createRealAgentManager(storage);
    const turnRouter = vi.fn(async () => null);
    agentManager.setTurnRouter(turnRouter);
    const notice = {
      status,
      fromProfile: "codex",
      toProfile: "claude",
      fromModel: "gpt-6.1-sol",
      model: "claude-sonnet-5-5",
      fromEffort: "high",
      effort: "high",
      resetsAt: "2026-09-30T21:00:00Z",
      reason: "Jev reassessed the task after quota exhaustion",
    };
    const createRouter = vi.fn(async () => ({
      provider: "claude" as const,
      model: notice.model,
      thinkingOptionId: notice.effort,
      routingNotice: notice,
    }));
    try {
      const parentId =
        kind === "mcp delegated"
          ? (
              await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
                workspaceId: "ws-source",
              })
            ).id
          : undefined;
      const config = {
        provider: "codex" as const,
        cwd: workdir,
        model: "gpt-6.1-sol",
        thinkingOptionId: "high",
      };
      const result = await createAgentCommand(
        {
          agentManager,
          agentStorage: storage,
          logger,
          providerSnapshotManager: createProviderSnapshotManagerStub().manager,
          createRouter,
        },
        kind === "session"
          ? {
              kind: "session",
              config,
              workspaceId: "ws-source",
              initialPrompt: "Implement the task",
              labels: { "pandaos.routing.mode": "auto" },
              provisionalTitle: null,
              firstAgentContext: { attachments: [] },
              buildSessionConfig: async (value) => ({ sessionConfig: value }),
            }
          : {
              kind: "mcp",
              provider: "codex/gpt-6.1-sol",
              config,
              cwd: workdir,
              workspaceId: "ws-source",
              title: "Task",
              initialPrompt: "Implement the task",
              background: true,
              labels: { "pandaos.routing.mode": "auto" },
              notifyOnFinish: false,
              callerAgentId: parentId,
            },
      );
      expect(result.initialPromptStarted).toBe(true);
      expect(result.initialPromptError).toBeNull();
      await vi.waitFor(() =>
        expect(agentManager.getAgent(result.snapshot.id)?.lifecycle).toBe("idle"),
      );
      await agentManager.flush();
      await storage.flush();
      expect(createRouter).toHaveBeenCalledOnce();
      expect(turnRouter).not.toHaveBeenCalled();
      expect(agentManager.getAgent(result.snapshot.id)?.config.routingNotice).toEqual(notice);
      expect((await storage.get(result.snapshot.id))?.config?.routingNotice).toEqual(notice);
    } finally {
      await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
    }
  },
);

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

test("actual MCP initial prompts own provisional titles while explicit child role names remain manual", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-ownership-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const dependencies = {
    agentManager,
    agentStorage: storage,
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    ensureWorkspaceForCreate: async () => "workspace-fixture",
  };
  try {
    const task = await createAgentCommand(dependencies, {
      kind: "mcp",
      provider: "codex",
      cwd: workdir,
      initialPrompt: "Reply with exactly the verified result",
      background: true,
    });
    await vi.waitFor(async () =>
      expect((await storage.get(task.snapshot.id))?.lastUserMessageAt).toBeTruthy(),
    );
    expect((await storage.get(task.snapshot.id))?.titleSource).toBe("provisional");
    expect(agentManager.getAgent(task.snapshot.id)?.config.title).toBeUndefined();
    const greeting = await createAgentCommand(dependencies, {
      kind: "mcp",
      provider: "codex",
      cwd: workdir,
      initialPrompt: "hi",
      background: true,
    });
    expect((await storage.get(greeting.snapshot.id))?.title).toBeNull();
    expect((await storage.get(greeting.snapshot.id))?.titleSource).not.toBe("manual");
    const child = await createAgentCommand(dependencies, {
      kind: "mcp",
      provider: "codex",
      cwd: workdir,
      initialPrompt: "Run independent verification",
      title: "Independent verifier",
      background: true,
      callerAgentId: task.snapshot.id,
    });
    expect((await storage.get(child.snapshot.id))?.title).toBe("Independent verifier");
    expect((await storage.get(child.snapshot.id))?.titleSource).toBe("manual");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});
