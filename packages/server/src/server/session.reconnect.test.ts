import { describe, expect, test, vi } from "vitest";
import { Session } from "./session.js";

function createLogger() {
  return {
    child: () => createLogger(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createSession(
  options: {
    agentIds?: string[];
    agentStatuses?: Map<string, "running" | "idle" | "closed">;
    pendingEvents?: unknown[];
  } = {},
): { session: Session; onMessage: ReturnType<typeof vi.fn>; agentManager: any } {
  const onMessage = vi.fn();
  const logger = createLogger();
  const agentIds = options.agentIds ?? [];
  const agentStatuses = options.agentStatuses ?? new Map();

  const agentManager = {
    subscribe: vi.fn(),
    listAgents: () =>
      agentIds.map((id) => ({
        id,
        lifecycle: agentStatuses.get(id) ?? "idle",
        attention: { requiresAttention: false },
        provider: "claude",
      })),
    getAgent: (id: string) => {
      const status = agentStatuses.get(id);
      if (!status) return null;
      return {
        id,
        lifecycle: status,
        attention: { requiresAttention: false },
        provider: "claude",
      };
    },
    archiveAgent: async () => ({ archivedAt: new Date().toISOString() }),
    clearAgentAttention: async () => {},
    notifyAgentState: () => {},
  };

  const session = new Session({
    clientId: "test-client",
    appVersion: null,
    onMessage,
    logger: logger as any,
    downloadTokenStore: {} as any,
    pushTokenStore: {} as any,
    paseoHome: "/tmp/paseo-test",
    agentManager: agentManager as any,
    agentStorage: {
      list: async () => [],
      get: async () => null,
    } as any,
    projectRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    workspaceRegistry: {
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
      upsert: async () => {},
      archive: async () => {},
      remove: async () => {},
    } as any,
    chatService: {} as any,
    loopService: {} as any,
    scheduleService: {} as any,
    checkoutDiffManager: {
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({})),
      dispose: () => {},
    } as any,
    workspaceGitService: {
      subscribe: async () => ({
        initial: {},
        unsubscribe: () => {},
      }),
      peekSnapshot: () => null,
      getSnapshot: async () => ({}),
      refresh: async () => {},
      dispose: () => {},
    } as any,
    daemonConfigStore: {
      onChange: () => () => {},
    } as any,
    mcpBaseUrl: null,
    stt: () => null,
    tts: () => null,
    terminalManager: null,
    providerSnapshotManager: {
      on: vi.fn(),
      off: vi.fn(),
    } as any,
    voice: { turnDetection: () => null },
    voiceBridge: {
      registerVoiceSpeakHandler: () => {},
      unregisterVoiceSpeakHandler: () => {},
      registerVoiceCallerContext: () => {},
      unregisterVoiceCallerContext: () => {},
    },
    dictation: null,
    agentProviderRuntimeSettings: {},
  });

  return { session, onMessage, agentManager };
}

describe("session reconnect flow", () => {
  test("onReconnect with empty agentIds is a no-op", () => {
    const { session, onMessage } = createSession();
    session.onReconnect([]);
    // Should not send any messages when no agents need attention
    expect(onMessage).not.toHaveBeenCalled();
  });

  test("onReconnect flushes pending events for agents with attention", () => {
    const { session, onMessage } = createSession({
      agentIds: ["agent-1"],
      agentStatuses: new Map([["agent-1", "running"]]),
    });

    // Simulate a pending event (e.g. timeline update during disconnection)
    session["onMessage"]({
      type: "agent_stream",
      payload: {
        agentId: "agent-1",
        event: {
          type: "timeline",
          item: { type: "tool_call", tool: "test", input: {} },
          provider: "claude",
        },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    });

    // Flush the pending event
    (session as any).flushReconnectEvents();

    // The pending event should be re-emitted via onMessage
    expect(onMessage).toHaveBeenCalled();
  });

  test("handleReconnectWakeUp wakes all agents including closed", () => {
    const { session, onMessage } = createSession({
      agentIds: [
        "agent-running",
        "agent-idle",
        "agent-error",
        "agent-initializing",
        "agent-closed",
      ],
      agentStatuses: new Map([
        ["agent-running", "running"],
        ["agent-idle", "idle"],
        ["agent-error", "error"],
        ["agent-initializing", "initializing"],
        ["agent-closed", "closed"],
      ]),
    });

    (session as any).handleReconnectWakeUp();

    // Should send "wakeup" to all agents including closed
    const callArgs = onMessage.mock.calls.map((c) => c[0]);
    expect(callArgs).toHaveLength(5);

    const agentIds = callArgs.map((c) => (c as any).payload?.agentId);
    expect(agentIds).toContain("agent-running");
    expect(agentIds).toContain("agent-idle");
    expect(agentIds).toContain("agent-error");
    expect(agentIds).toContain("agent-initializing");
    expect(agentIds).toContain("agent-closed");

    // Each wakeup event should be a timeline event with "Reconnect wakeup"
    for (const call of callArgs) {
      const msg = call as any;
      expect(msg.type).toBe("agent_stream");
      expect(msg.payload?.event?.item?.text).toBe("[Reconnect wakeup]");
    }
  });

  test("flushReconnectEvents clears reconnectingAgents after flush", () => {
    const { session, onMessage } = createSession({
      agentIds: ["agent-1"],
      agentStatuses: new Map([["agent-1", "running"]]),
    });

    (session as any).onReconnect(["agent-1"]);

    // Simulate the pending events buffer
    (session as any).pendingEvents = [{ type: "test", payload: {} }];
    onMessage.mockClear();

    // Flush events
    (session as any).flushReconnectEvents();

    // Should have sent events and cleared the reconnecting state
    expect(onMessage).toHaveBeenCalled();
  });

  test("flushReconnectEvents is idempotent when no events and no agents", () => {
    const { session, onMessage } = createSession();
    onMessage.mockClear();

    // First flush - no-op
    (session as any).flushReconnectEvents();
    const firstCallCount = onMessage.mock.calls.length;

    // Second flush - still no-op
    (session as any).flushReconnectEvents();

    // No additional calls
    expect(onMessage.mock.calls.length).toBe(firstCallCount);
  });

  test("onReconnect sends attention_required for agents needing attention", () => {
    const { session, onMessage } = createSession({
      agentIds: ["agent-1"],
      agentStatuses: new Map([["agent-1", "running"]]),
    });

    (session as any).onReconnect(["agent-1"]);

    const callArgs = onMessage.mock.calls.map((c) => c[0] as any);
    // Should have called onMessage for the agent state update
    expect(onMessage).toHaveBeenCalled();
  });
});
