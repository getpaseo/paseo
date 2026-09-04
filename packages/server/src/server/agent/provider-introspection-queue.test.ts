import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
} from "./agent-sdk-types.js";
import { AgentManager } from "./agent-manager.js";
import { ProviderIntrospectionQueue } from "./provider-introspection-queue.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function createSession(
  config: AgentSessionConfig,
  options: { features?: AgentFeature[]; close?: () => Promise<void> } = {},
): AgentSession {
  return {
    provider: config.provider,
    id: null,
    capabilities: TEST_CAPABILITIES,
    features: options.features,
    async run(): Promise<AgentRunResult> {
      return { sessionId: config.provider, finalText: "", timeline: [] };
    },
    async startTurn() {
      return { turnId: "turn-test" };
    },
    subscribe(_callback: (event: AgentStreamEvent) => void) {
      return () => {};
    },
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {},
    async getRuntimeInfo() {
      return {
        provider: config.provider,
        sessionId: null,
        model: config.model ?? null,
        modeId: config.modeId ?? null,
      };
    },
    async getAvailableModes() {
      return [];
    },
    async getCurrentMode() {
      return config.modeId ?? null;
    },
    async setMode() {},
    getPendingPermissions() {
      return [];
    },
    async respondToPermission() {},
    describePersistence() {
      return null;
    },
    async interrupt() {},
    async close() {
      await options.close?.();
    },
    async listCommands() {
      return [];
    },
  };
}

function createClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    provider: "codex",
    capabilities: TEST_CAPABILITIES,
    async createSession(config) {
      return createSession(config);
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async fetchCatalog(_options: FetchCatalogOptions) {
      return { models: [] as AgentModelDefinition[], modes: [] as AgentMode[] };
    },
    async isAvailable() {
      return true;
    },
    ...overrides,
  } satisfies AgentClient;
}

class ObservedProviderIntrospectionQueue extends ProviderIntrospectionQueue {
  private runCalls = 0;
  private readonly secondRunStarted = deferred<void>();

  override run<T>(
    provider: AgentSessionConfig["provider"],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.runCalls += 1;
    if (this.runCalls === 2) {
      this.secondRunStarted.resolve();
    }
    return super.run(provider, operation);
  }

  waitForSecondRun(): Promise<void> {
    return this.secondRunStarted.promise;
  }
}

test("serializes draft command and feature session creation per provider", async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const firstAllowed = deferred<void>();
  const secondAllowed = deferred<void>();
  let createCalls = 0;
  let activeCreations = 0;
  let maxActiveCreations = 0;
  const client = createClient({
    async createSession(config) {
      const call = createCalls;
      createCalls += 1;
      activeCreations += 1;
      maxActiveCreations = Math.max(maxActiveCreations, activeCreations);
      if (call === 0) {
        firstStarted.resolve();
        await firstAllowed.promise;
      } else {
        secondStarted.resolve();
        await secondAllowed.promise;
      }
      activeCreations -= 1;
      return createSession(config);
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config = {
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    modeId: "default",
  } as const;

  const commands = manager.listDraftCommands(config);
  await firstStarted.promise;
  const features = manager.listDraftFeatures(config);

  expect({ createCalls, maxActiveCreations }).toEqual({ createCalls: 1, maxActiveCreations: 1 });
  firstAllowed.resolve();
  await secondStarted.promise;
  expect({ createCalls, maxActiveCreations }).toEqual({ createCalls: 2, maxActiveCreations: 1 });
  secondAllowed.resolve();

  await expect(Promise.all([commands, features])).resolves.toEqual([[], []]);
});

test("a failed draft session does not wedge or poison later identical requests", async () => {
  let createCalls = 0;
  const client = createClient({
    async createSession(config) {
      createCalls += 1;
      if (createCalls === 1) {
        throw new Error("provider startup failed");
      }
      return createSession(config);
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config = {
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    modeId: "default",
  } as const;

  await expect(manager.listDraftFeatures(config)).rejects.toThrow("provider startup failed");
  await expect(manager.listDraftFeatures(config)).resolves.toEqual([]);
  expect(createCalls).toBe(2);
});

test("waits for registered timeout cleanup before releasing the provider queue", async () => {
  vi.useFakeTimers();
  const catalogStarted = deferred<void>();
  const catalogAborted = deferred<void>();
  const cleanupAllowed = deferred<void>();
  const draftStarted = deferred<void>();
  let catalogActive = false;
  let createSessionCalls = 0;
  const client = createClient({
    async fetchCatalog(_options, context) {
      if (!context) throw new Error("missing refresh context");
      catalogActive = true;
      catalogStarted.resolve();
      context.registerAbortCleanup(async () => {
        catalogAborted.resolve();
        await cleanupAllowed.promise;
        catalogActive = false;
      });
      return await new Promise<never>(() => {
        context.signal.addEventListener("abort", () => undefined, { once: true });
      });
    },
    async createSession(config) {
      createSessionCalls += 1;
      expect(catalogActive).toBe(false);
      draftStarted.resolve();
      return createSession(config);
    },
  });
  const queue = new ProviderIntrospectionQueue();
  const snapshotManager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    refreshTimeoutMs: 100,
    extraClients: { codex: client },
    providerIntrospectionQueue: queue,
  });
  const agentManager = new AgentManager({
    clients: { codex: client },
    providerIntrospectionQueue: queue,
    logger: createTestLogger(),
  });
  const config = {
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    modeId: "default",
  } as const;

  try {
    const snapshot = snapshotManager.getProvider({
      cwd: process.cwd(),
      provider: "codex",
      wait: true,
    });
    await catalogStarted.promise;
    const features = agentManager.listDraftFeatures(config);

    await vi.advanceTimersByTimeAsync(100);
    await catalogAborted.promise;
    expect(createSessionCalls).toBe(0);

    cleanupAllowed.resolve();
    await draftStarted.promise;

    await expect(snapshot).resolves.toMatchObject({
      provider: "codex",
      status: "error",
      error: "Timed out refreshing Codex after 100ms",
    });
    await expect(features).resolves.toEqual([]);
    expect(createSessionCalls).toBe(1);
  } finally {
    snapshotManager.destroy();
    vi.useRealTimers();
  }
});

test("serializes snapshot warmup with draft session creation for the same provider", async () => {
  const catalogStarted = deferred<void>();
  const catalogAllowed = deferred<void>();
  const draftSessionStarted = deferred<void>();
  let activeProcesses = 0;
  let maxActiveProcesses = 0;
  let createSessionCalls = 0;
  const client = createClient({
    async fetchCatalog() {
      activeProcesses += 1;
      maxActiveProcesses = Math.max(maxActiveProcesses, activeProcesses);
      catalogStarted.resolve();
      await catalogAllowed.promise;
      activeProcesses -= 1;
      return { models: [], modes: [] };
    },
    async createSession(config) {
      createSessionCalls += 1;
      activeProcesses += 1;
      maxActiveProcesses = Math.max(maxActiveProcesses, activeProcesses);
      draftSessionStarted.resolve();
      activeProcesses -= 1;
      return createSession(config);
    },
  });
  const queue = new ObservedProviderIntrospectionQueue();
  const snapshotManager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    extraClients: { codex: client },
    providerIntrospectionQueue: queue,
  });
  const agentManager = new AgentManager({
    clients: { codex: client },
    providerIntrospectionQueue: queue,
    logger: createTestLogger(),
  });
  const config = {
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    modeId: "default",
  } as const;

  try {
    const warmup = snapshotManager.warmUpSnapshotForCwd({
      cwd: process.cwd(),
      providers: ["codex"],
    });
    await catalogStarted.promise;
    const features = agentManager.listDraftFeatures(config);
    await queue.waitForSecondRun();

    expect({ createSessionCalls, maxActiveProcesses }).toEqual({
      createSessionCalls: 0,
      maxActiveProcesses: 1,
    });
    catalogAllowed.resolve();
    await draftSessionStarted.promise;
    await expect(Promise.all([warmup, features])).resolves.toEqual([undefined, []]);
    expect(maxActiveProcesses).toBe(1);
  } finally {
    snapshotManager.destroy();
  }
});

test("does not serialize real agent creation behind draft introspection", async () => {
  const draftStarted = deferred<void>();
  const draftAllowed = deferred<void>();
  const agentStarted = deferred<void>();
  let createCalls = 0;
  let activeCreations = 0;
  let maxActiveCreations = 0;
  const client = createClient({
    async createSession(config) {
      const call = createCalls;
      createCalls += 1;
      activeCreations += 1;
      maxActiveCreations = Math.max(maxActiveCreations, activeCreations);
      if (call === 0) {
        draftStarted.resolve();
        await draftAllowed.promise;
      } else {
        agentStarted.resolve();
      }
      activeCreations -= 1;
      return createSession(config);
    },
  });
  const queue = new ProviderIntrospectionQueue();
  const manager = new AgentManager({
    clients: { codex: client },
    providerIntrospectionQueue: queue,
    logger: createTestLogger(),
  });
  const config = {
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    modeId: "default",
  } as const;

  const draft = manager.listDraftCommands(config);
  await draftStarted.promise;
  const agent = manager.createAgent(config, "00000000-0000-4000-8000-000000000001", {
    workspaceId: undefined,
  });
  await agentStarted.promise;

  expect({ createCalls, maxActiveCreations }).toEqual({ createCalls: 2, maxActiveCreations: 2 });
  draftAllowed.resolve();
  await draft;
  const created = await agent;
  await manager.closeAgent(created.id);
});

test("falls back to the provider default model when the draft config has none", async () => {
  const sessionModels: Array<string | undefined> = [];
  const client = createClient({
    async fetchCatalog() {
      return {
        models: [
          { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" },
          { provider: "codex", id: "gpt-5.6-codex", label: "GPT-5.6 Codex", isDefault: true },
        ] as AgentModelDefinition[],
        modes: [] as AgentMode[],
      };
    },
    async createSession(config) {
      sessionModels.push(config.model);
      return {
        ...createSession(config),
        async listCommands() {
          return [{ name: "review", description: "Review changes", argumentHint: "" }];
        },
      };
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });

  const commands = await manager.listDraftCommands({
    provider: "codex",
    cwd: process.cwd(),
    modeId: "default",
  });

  expect(commands.map((command) => command.name)).toEqual(["review"]);
  expect(sessionModels).toEqual(["gpt-5.6-codex"]);
});

test("reports an error instead of an empty list when no model can be resolved", async () => {
  const client = createClient({
    async createSession(config) {
      return createSession(config);
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });

  await expect(
    manager.listDraftCommands({ provider: "codex", cwd: process.cwd(), modeId: "default" }),
  ).rejects.toThrow("has no models available");
});

test("serves repeat draft command requests from cache without respawning the provider", async () => {
  let createCalls = 0;
  const client = createClient({
    async createSession(config) {
      createCalls += 1;
      return {
        ...createSession(config),
        async listCommands() {
          return [{ name: "review", description: "Review changes", argumentHint: "" }];
        },
      };
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config = {
    provider: "codex",
    cwd: process.cwd(),
    model: "gpt-5.4",
    modeId: "default",
  } as const;

  const first = await manager.listDraftCommands(config);
  const second = await manager.listDraftCommands(config);

  expect(first.map((command) => command.name)).toEqual(["review"]);
  expect(second.map((command) => command.name)).toEqual(["review"]);
  expect(createCalls).toBe(1);
});
