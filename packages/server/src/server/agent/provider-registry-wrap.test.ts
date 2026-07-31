import { describe, expect, test, vi } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
  AgentClient,
  AgentPersistenceHandle,
} from "./agent-sdk-types.js";
import {
  shutdownAgentClients,
  wrapClientProvider,
  wrapSessionProvider,
} from "./provider-registry.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "listCommands",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly id = "session-1";
  readonly capabilities = CAPABILITIES;
  readonly features = [];
  readonly recordedCalls: string[] = [];

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    return () => {};
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* emptyHistory();
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return [];
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

async function* emptyHistory(): AsyncGenerator<AgentStreamEvent> {
  for (const event of [] as AgentStreamEvent[]) {
    yield event;
  }
}

describe("wrapSessionProvider", () => {
  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    await wrapped.listCommands?.();
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.recordedCalls).toEqual([
      "listCommands",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFakeClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    provider: "opencode",
    capabilities: CAPABILITIES,
    createSession: async () => {
      throw new Error("not implemented");
    },
    resumeSession: async () => {
      throw new Error("not implemented");
    },
    fetchCatalog: async () => ({ models: [], modes: [] }),
    isAvailable: async () => true,
    ...overrides,
  };
}

describe("wrapClientProvider", () => {
  test("forwards lifecycle methods with the inner provider and shares reentrant shutdown", async () => {
    const archiveNativeSession = vi.fn(async () => {});
    const unarchiveNativeSession = vi.fn(async () => {});
    const shutdownGate = createDeferred<void>();
    let reentrantShutdown: Promise<void> | null = null;
    let wrapped: AgentClient;
    const shutdown = vi.fn(async () => {
      reentrantShutdown = wrapped.shutdown?.() ?? null;
      await shutdownGate.promise;
    });
    const inner = createFakeClient({ archiveNativeSession, unarchiveNativeSession, shutdown });
    wrapped = wrapClientProvider("plexer", inner, [], [], false);
    const handle: AgentPersistenceHandle = {
      provider: "plexer",
      sessionId: "session-1",
      metadata: { cwd: "/workspace" },
    };

    await wrapped.archiveNativeSession?.(handle);
    await wrapped.unarchiveNativeSession?.(handle);
    const firstShutdown = wrapped.shutdown?.();
    const repeatedShutdown = wrapped.shutdown?.();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    shutdownGate.resolve();
    await Promise.all([firstShutdown, repeatedShutdown, reentrantShutdown]);

    expect(archiveNativeSession).toHaveBeenCalledWith({ ...handle, provider: "opencode" });
    expect(unarchiveNativeSession).toHaveBeenCalledWith({ ...handle, provider: "opencode" });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe("shutdownAgentClients", () => {
  test("returns a named timeout receipt instead of blocking daemon shutdown", async () => {
    const client = createFakeClient({ shutdown: async () => await new Promise<void>(() => {}) });

    await expect(
      shutdownAgentClients([client], createTestLogger(), { timeoutMs: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "opencode",
        status: "timed_out",
        timeoutMs: 1,
      }),
    ]);
  });
});
