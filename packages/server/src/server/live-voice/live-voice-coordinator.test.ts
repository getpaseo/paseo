import { describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentRealtimeVoiceEvent } from "../agent/agent-realtime-voice.js";
import {
  LiveVoiceCoordinator,
  type LiveVoiceAgentRef,
  type LiveVoiceContextProvider,
  type LiveVoiceUpdate,
} from "./live-voice-coordinator.js";

const OFFER_SDP = "v=0\r\no=- offer\r\n";
const ANSWER_SDP = "v=0\r\no=- answer\r\n";

interface FakeStartParams {
  sdp: string;
  voice?: string;
  realtimeSessionId: string;
  prompt?: string;
  initialItems?: Array<{ role: string; text: string }>;
  includeStartupContext?: boolean;
}

interface FakeProviderSession {
  realtimeStart(params: FakeStartParams): Promise<void>;
  realtimeStop(): Promise<void>;
  subscribeRealtimeEvents(callback: (event: AgentRealtimeVoiceEvent) => void): () => void;
  emit(event: AgentRealtimeVoiceEvent): void;
  readonly startCalls: FakeStartParams[];
  readonly stopCalls: number[];
  readonly subscriberCount: () => number;
}

/**
 * Mirrors the codex seam: `realtimeStart` resolves with nothing and the answer
 * SDP arrives out of band, so tests can drive either ordering.
 */
function createFakeProviderSession(options?: {
  onStart?: (emit: (event: AgentRealtimeVoiceEvent) => void) => void;
  startError?: Error;
}): FakeProviderSession {
  const subscribers = new Set<(event: AgentRealtimeVoiceEvent) => void>();
  const startCalls: FakeStartParams[] = [];
  const stopCalls: number[] = [];
  const emit = (event: AgentRealtimeVoiceEvent): void => {
    for (const subscriber of Array.from(subscribers)) subscriber(event);
  };
  return {
    startCalls,
    stopCalls,
    subscriberCount: () => subscribers.size,
    emit,
    async realtimeStart(params) {
      startCalls.push(params);
      if (options?.startError) throw options.startError;
      options?.onStart?.(emit);
    },
    async realtimeStop() {
      stopCalls.push(stopCalls.length);
    },
    subscribeRealtimeEvents(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}

interface Harness {
  coordinator: LiveVoiceCoordinator;
  provider: FakeProviderSession;
  agent: LiveVoiceAgentRef & { session: unknown };
  updates: LiveVoiceUpdate[];
  owner: { sessionKey: object; sourceKey: object };
  triggerAgentClosing: (agentId: string) => void;
  setAgent: (agent: LiveVoiceAgentRef | null) => void;
}

function createHarness(options?: {
  provider?: FakeProviderSession;
  agentOverrides?: Partial<LiveVoiceAgentRef>;
  startSdpTimeoutMs?: number;
  context?: LiveVoiceContextProvider;
}): Harness {
  const provider = options?.provider ?? createFakeProviderSession();
  const agent: LiveVoiceAgentRef = {
    lifecycle: "idle",
    capabilities: { supportsLiveVoice: true },
    session: provider,
    activeForegroundTurnId: null,
    ...options?.agentOverrides,
  };
  let current: LiveVoiceAgentRef | null = agent;
  const closingListeners = new Set<(agentId: string) => void>();
  const updates: LiveVoiceUpdate[] = [];
  const coordinator = new LiveVoiceCoordinator({
    agents: {
      getAgent: () => current,
      onAgentClosing: (callback) => {
        closingListeners.add(callback);
        return () => closingListeners.delete(callback);
      },
    },
    logger: createTestLogger(),
    ...(options?.startSdpTimeoutMs === undefined
      ? {}
      : { startSdpTimeoutMs: options.startSdpTimeoutMs }),
    ...(options?.context ? { context: options.context } : {}),
  });
  return {
    coordinator,
    provider,
    agent: agent as LiveVoiceAgentRef & { session: unknown },
    updates,
    owner: { sessionKey: {}, sourceKey: {} },
    triggerAgentClosing: (agentId) => {
      for (const listener of Array.from(closingListeners)) listener(agentId);
    },
    setAgent: (next) => {
      current = next;
    },
  };
}

function startCall(harness: Harness, owner = harness.owner) {
  return harness.coordinator.start({
    agentId: "agent-1",
    offerSdp: OFFER_SDP,
    owner,
    emit: (update) => harness.updates.push(update),
  });
}

describe("LiveVoiceCoordinator", () => {
  it("accepts a call when the answer SDP arrives before the start response resolves", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });

    const result = await startCall(harness);

    expect(result).toEqual({
      accepted: true,
      liveSessionId: expect.any(String),
      answerSdp: ANSWER_SDP,
    });
    expect(provider.startCalls).toHaveLength(1);
    expect(provider.startCalls[0]).toMatchObject({
      sdp: OFFER_SDP,
      realtimeSessionId: result.accepted ? result.liveSessionId : "",
    });
    expect(harness.updates.map((update) => update.event.kind)).toEqual(["started"]);
    expect(harness.updates[0]?.seq).toBe(0);
  });

  it("accepts a call when the answer SDP arrives after the start response resolves", async () => {
    const provider = createFakeProviderSession();
    const harness = createHarness({ provider });

    const pending = startCall(harness);
    // Let realtimeStart settle first, then deliver the notification.
    await Promise.resolve();
    await Promise.resolve();
    provider.emit({ kind: "sdp", sdp: ANSWER_SDP });

    const result = await pending;
    expect(result).toEqual({
      accepted: true,
      liveSessionId: expect.any(String),
      answerSdp: ANSWER_SDP,
    });
  });

  it("forwards finalized transcripts with a monotonic seq", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    provider.emit({ kind: "transcript", role: "user", text: "hello" });
    provider.emit({ kind: "transcript", role: "assistant", text: "hi" });

    expect(harness.updates.map((update) => update.seq)).toEqual([0, 1, 2]);
    expect(harness.updates[1]?.event).toMatchObject({
      kind: "transcript",
      role: "user",
      text: "hello",
    });
    expect(harness.updates[2]?.event).toMatchObject({ kind: "transcript", role: "assistant" });
  });

  it("rejects a second acquire on the same agent with busy", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    const second = await startCall(harness, { sessionKey: {}, sourceKey: {} });

    expect(second).toMatchObject({ accepted: false, errorCode: "busy" });
    expect(provider.startCalls).toHaveLength(1);
  });

  it("rejects agents without the live voice capability as unsupported", async () => {
    const harness = createHarness({ agentOverrides: { capabilities: {} } });
    expect(await startCall(harness)).toMatchObject({ accepted: false, errorCode: "unsupported" });
  });

  it("rejects a mid-turn agent as agent_busy", async () => {
    const harness = createHarness({
      agentOverrides: { lifecycle: "running", activeForegroundTurnId: "turn-1" },
    });
    expect(await startCall(harness)).toMatchObject({ accepted: false, errorCode: "agent_busy" });
  });

  it("rejects an unloaded agent as agent_not_found", async () => {
    const harness = createHarness();
    harness.setAgent(null);
    expect(await startCall(harness)).toMatchObject({
      accepted: false,
      errorCode: "agent_not_found",
    });
  });

  it("treats a stop with a stale liveSessionId as a no-op", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    harness.coordinator.stop({ agentId: "agent-1", liveSessionId: "not-the-live-session" });

    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(true);
    expect(provider.stopCalls).toHaveLength(0);
    expect(harness.updates.map((update) => update.event.kind)).toEqual(["started"]);
  });

  it("closes with cause requested on a matching stop", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("expected the call to be accepted");

    harness.coordinator.stop({ agentId: "agent-1", liveSessionId: result.liveSessionId });
    // A second stop must not produce a second closed update.
    harness.coordinator.stop({ agentId: "agent-1", liveSessionId: result.liveSessionId });

    expect(harness.updates.at(-1)?.event).toMatchObject({ kind: "closed", cause: "requested" });
    expect(harness.updates.filter((update) => update.event.kind === "closed")).toHaveLength(1);
    expect(provider.stopCalls).toHaveLength(1);
    expect(provider.subscriberCount()).toBe(0);
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
  });

  it("tears the call down immediately when the owning socket detaches", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    harness.coordinator.closeForSource(harness.owner.sourceKey);

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "owner_disconnected",
    });
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
    expect(provider.stopCalls).toHaveLength(1);
  });

  it("leaves calls owned by other sockets alone on detach", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    harness.coordinator.closeForSource({});

    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(true);
  });

  it("closes with cause codex_exit when the provider transport dies mid-call", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    provider.emit({ kind: "transport_closed", reason: "Codex app-server exited" });

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "codex_exit",
      detail: "Codex app-server exited",
    });
    // The transport is gone; never ask it to stop (that would respawn codex).
    expect(provider.stopCalls).toHaveLength(0);
  });

  it("closes with cause codex_closed when codex ends the realtime session", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    provider.emit({ kind: "closed", reason: "client_closed" });

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "codex_closed",
      detail: "client_closed",
    });
    expect(provider.stopCalls).toHaveLength(0);
  });

  it("emits a fatal error then closes on a codex realtime error", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    provider.emit({ kind: "error", message: "invalid_offer" });

    expect(harness.updates.map((update) => update.event.kind)).toEqual([
      "started",
      "error",
      "closed",
    ]);
    expect(harness.updates[1]?.event).toMatchObject({ fatal: true, message: "invalid_offer" });
    expect(harness.updates[2]?.event).toMatchObject({ kind: "closed", cause: "error" });
  });

  it("closes with cause agent_closed when the agent session is torn down mid-call", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });
    await startCall(harness);

    harness.triggerAgentClosing("agent-1");

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "agent_closed",
    });
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
    // onAgentClosing fires before the provider session is disposed, so the
    // coordinator still tells codex to end the upstream realtime session.
    expect(provider.stopCalls).toHaveLength(1);
  });

  it("fails with start_failed and releases the agent when the answer SDP never arrives", async () => {
    const provider = createFakeProviderSession();
    const harness = createHarness({ provider, startSdpTimeoutMs: 5 });

    const result = await startCall(harness);

    expect(result).toMatchObject({ accepted: false, errorCode: "start_failed" });
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
    // The call never went active, so the owner gets no push — only the response.
    expect(harness.updates).toEqual([]);
    expect(provider.subscriberCount()).toBe(0);
    expect(provider.stopCalls).toHaveLength(1);

    // The agent is released, so a retry can acquire it again.
    provider.emit({ kind: "sdp", sdp: ANSWER_SDP });
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
  });

  it("fails with start_failed when the provider rejects the start request", async () => {
    const provider = createFakeProviderSession({ startError: new Error("realtime disabled") });
    const harness = createHarness({ provider });

    const result = await startCall(harness);

    expect(result).toMatchObject({
      accepted: false,
      errorCode: "start_failed",
      errorMessage: "realtime disabled",
    });
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
  });

  it("does not resurrect a call closed while the handshake was in flight", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => {
        emit({ kind: "sdp", sdp: ANSWER_SDP });
        emit({ kind: "transport_closed", reason: "Codex app-server exited" });
      },
    });
    const harness = createHarness({ provider });

    const result = await startCall(harness);

    expect(result).toMatchObject({ accepted: false, errorCode: "start_failed" });
    expect(harness.coordinator.hasActiveCall("agent-1")).toBe(false);
    expect(harness.updates).toEqual([]);
  });

  it("passes the Paseo prompt and snapshot to the provider and suppresses its startup context", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const context: LiveVoiceContextProvider = {
      build: async (agentId) => ({
        prompt: `prompt for ${agentId}`,
        initialItems: [{ role: "developer", text: "state snapshot" }],
      }),
    };
    const harness = createHarness({ provider, context });

    await startCall(harness);

    expect(provider.startCalls[0]).toMatchObject({
      prompt: "prompt for agent-1",
      initialItems: [{ role: "developer", text: "state snapshot" }],
      includeStartupContext: false,
    });
  });

  it("still places the call when building the Paseo context fails", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const context: LiveVoiceContextProvider = {
      build: async () => {
        throw new Error("workspace registry unavailable");
      },
    };
    const harness = createHarness({ provider, context });

    const result = await startCall(harness);

    expect(result).toMatchObject({ accepted: true });
    // Falls back to the provider's own context rather than failing the call.
    expect(provider.startCalls[0]?.prompt).toBeUndefined();
    expect(provider.startCalls[0]?.includeStartupContext).toBeUndefined();
  });

  it("omits context fields entirely when no provider is configured", async () => {
    const provider = createFakeProviderSession({
      onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
    });
    const harness = createHarness({ provider });

    await startCall(harness);

    expect(provider.startCalls[0]).not.toHaveProperty("prompt");
    expect(provider.startCalls[0]).not.toHaveProperty("initialItems");
    expect(provider.startCalls[0]).not.toHaveProperty("includeStartupContext");
  });
});
