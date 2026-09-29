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
import { DEFAULT_PROVIDER_REFRESH_TIMEOUT_MS } from "./provider-refresh-deadline.js";

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

test("refreshes draft commands after the checkout's skills change", async () => {
  let name = "old-branch-skill";
  const client = createClient({
    async createSession(config) {
      return {
        ...createSession(config),
        async listCommands() {
          return [{ name, description: "", argumentHint: "" }];
        },
      };
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config = { provider: "codex", cwd: process.cwd(), model: "gpt-5.4" };

  expect(await manager.listDraftCommands(config)).toEqual([
    { name: "old-branch-skill", description: "", argumentHint: "" },
  ]);
  name = "new-branch-skill";
  expect(await manager.listDraftCommands(config)).toEqual([
    { name: "new-branch-skill", description: "", argumentHint: "" },
  ]);
});

test("shares model discovery and command listing for concurrent model-less drafts", async () => {
  const catalogStarted = deferred<void>();
  const catalogAllowed = deferred<void>();
  let catalogCalls = 0;
  let sessionCalls = 0;
  const commands = [{ name: "review", description: "", argumentHint: "" }];
  const client = createClient({
    async fetchCatalog() {
      catalogCalls++;
      catalogStarted.resolve();
      await catalogAllowed.promise;
      return { models: [{ provider: "codex", id: "default-model", label: "Model" }], modes: [] };
    },
    async createSession(config) {
      sessionCalls++;
      return {
        ...createSession(config),
        async listCommands() {
          return commands;
        },
      };
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config = { provider: "codex", cwd: process.cwd() };
  const requests = Array.from({ length: 4 }, () => manager.listDraftCommands(config));
  await catalogStarted.promise;
  catalogAllowed.resolve();
  expect(await Promise.all(requests)).toEqual([commands, commands, commands, commands]);
  expect({ catalogCalls, sessionCalls }).toEqual({ catalogCalls: 1, sessionCalls: 1 });
});

test("lists commands directly without requiring a model catalog", async () => {
  const commands = [{ name: "review", description: "", argumentHint: "" }];
  const client = createClient({
    async fetchCatalog() {
      throw new Error("catalog unavailable");
    },
    async listCommands() {
      return commands;
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  await expect(
    manager.listDraftCommands({ provider: "codex", cwd: process.cwd() }),
  ).resolves.toEqual(commands);
});

test("a timed-out model probe cannot create a late session and permits a retry", async () => {
  vi.useFakeTimers();
  const started = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  let sessionCalls = 0;
  const commands = [{ name: "review", description: "", argumentHint: "" }];
  const client = createClient({
    async fetchCatalog() {
      calls++;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return { models: [{ provider: "codex", id: "model", label: "Model" }], modes: [] };
    },
    async createSession(config) {
      sessionCalls++;
      return {
        ...createSession(config),
        async listCommands() {
          return commands;
        },
      };
    },
  });
  const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const config = { provider: "codex", cwd: process.cwd() };
  try {
    const rejected = expect(manager.listDraftCommands(config)).rejects.toThrow(
      "Timed out refreshing codex",
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_REFRESH_TIMEOUT_MS);
    await rejected;
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionCalls).toBe(0);
    await expect(manager.listDraftCommands(config)).resolves.toEqual(commands);
    expect(calls).toBe(2);
    expect(sessionCalls).toBe(1);
  } finally {
    release.resolve();
    vi.useRealTimers();
  }
});
