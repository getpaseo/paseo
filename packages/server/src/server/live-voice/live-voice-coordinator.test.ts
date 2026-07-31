import os from "node:os";
import { describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentRealtimeVoiceEvent } from "../agent/agent-realtime-voice.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import {
  LiveVoiceCoordinator,
  type LiveVoiceContextProvider,
  type LiveVoiceUpdate,
} from "./live-voice-coordinator.js";
import { LiveVoiceRouteBroker } from "./live-voice-route-broker.js";

const OFFER_SDP = "v=0\r\no=- offer\r\n";
const ANSWER_SDP = "v=0\r\no=- answer\r\n";
const HOST_CWD = "/home/test-user";

interface FakeStartParams {
  sdp: string;
  voice?: string;
  realtimeSessionId: string;
  prompt?: string;
  initialItems?: Array<{ role: string; text: string }>;
  includeStartupContext?: boolean;
}

interface FakeAppendTextParams {
  text: string;
  role?: "user" | "developer" | "assistant";
}

interface FakeProviderSession {
  realtimeStart(params: FakeStartParams): Promise<void>;
  realtimeStop(): Promise<void>;
  realtimeAppendText(params: FakeAppendTextParams): Promise<void>;
  readonly appendedText: FakeAppendTextParams[];
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
  appendTextError?: Error;
}): FakeProviderSession {
  const subscribers = new Set<(event: AgentRealtimeVoiceEvent) => void>();
  const startCalls: FakeStartParams[] = [];
  const stopCalls: number[] = [];
  const appendedText: FakeAppendTextParams[] = [];
  const emit = (event: AgentRealtimeVoiceEvent): void => {
    for (const subscriber of Array.from(subscribers)) subscriber(event);
  };
  return {
    startCalls,
    stopCalls,
    appendedText,
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
    async realtimeAppendText(params) {
      if (options?.appendTextError) throw options.appendTextError;
      appendedText.push(params);
    },
    subscribeRealtimeEvents(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}

/** Answers the SDP synchronously from `realtimeStart`, the common happy path. */
function answeringProvider(): FakeProviderSession {
  return createFakeProviderSession({ onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }) });
}

interface HostRecord {
  agentId: string;
  provider: FakeProviderSession;
}

interface Harness {
  coordinator: LiveVoiceCoordinator;
  hosts: HostRecord[];
  /** The provider of the first host session, i.e. the one most tests drive. */
  provider: () => FakeProviderSession;
  createConfigs: AgentSessionConfig[];
  closedHostIds: string[];
  routeBroker: LiveVoiceRouteBroker;
  routeRequests: unknown[];
  routingRegisteredDuringCreate: boolean[];
  updates: LiveVoiceUpdate[];
  owner: { sessionKey: object };
  triggerAgentClosing: (agentId: string) => void;
}

function createHarness(options?: {
  makeProvider?: () => FakeProviderSession;
  capabilities?: { readonly [capability: string]: boolean | undefined };
  availability?: { available: boolean; error?: string | null };
  availabilityGate?: Promise<unknown>;
  createAgentError?: Error;
  /** Resolves before `createAgent` returns, so tests can close mid-spawn. */
  createAgentGate?: Promise<unknown>;
  startSdpTimeoutMs?: number;
  context?: LiveVoiceContextProvider;
  /** `null` omits the option so the coordinator's own default applies. */
  hostCwd?: string | null;
}): Harness {
  const makeProvider = options?.makeProvider ?? answeringProvider;
  const hosts: HostRecord[] = [];
  const createConfigs: AgentSessionConfig[] = [];
  const closedHostIds: string[] = [];
  const closingListeners = new Set<(agentId: string) => void>();
  const updates: LiveVoiceUpdate[] = [];
  const routeRequests: unknown[] = [];
  const routeBroker = new LiveVoiceRouteBroker();
  const routingRegisteredDuringCreate: boolean[] = [];
  const notifyClosing = (agentId: string): void => {
    for (const listener of Array.from(closingListeners)) listener(agentId);
  };
  const coordinator = new LiveVoiceCoordinator({
    agents: {
      getProviderAvailability: async () => {
        if (options?.availabilityGate) {
          await options.availabilityGate;
        }
        return options?.availability ?? { available: true, error: null };
      },
      createAgent: async (config, agentId) => {
        createConfigs.push(config);
        if (!agentId) throw new Error("expected the coordinator to choose the host id");
        routingRegisteredDuringCreate.push(routeBroker.isRegisteredHost(agentId));
        if (options?.createAgentGate) {
          await options.createAgentGate;
        }
        if (options?.createAgentError) {
          throw options.createAgentError;
        }
        const host: HostRecord = {
          agentId,
          provider: makeProvider(),
        };
        hosts.push(host);
        return {
          id: host.agentId,
          capabilities: options?.capabilities ?? { supportsLiveVoice: true },
          session: host.provider,
        };
      },
      // The real manager fires `onAgentClosing` from inside `closeAgent`, so the
      // fake does too: closing a host must not re-enter into a second teardown.
      closeAgent: async (agentId) => {
        closedHostIds.push(agentId);
        notifyClosing(agentId);
      },
      onAgentClosing: (callback) => {
        closingListeners.add(callback);
        return () => closingListeners.delete(callback);
      },
    },
    logger: createTestLogger(),
    routeBroker,
    createHostAgentId: () => `host-${hosts.length + 1}`,
    ...(options?.hostCwd === null ? {} : { hostCwd: options?.hostCwd ?? HOST_CWD }),
    ...(options?.startSdpTimeoutMs === undefined
      ? {}
      : { startSdpTimeoutMs: options.startSdpTimeoutMs }),
    ...(options?.context ? { context: options.context } : {}),
  });
  return {
    coordinator,
    hosts,
    provider: () => {
      const host = hosts[0];
      if (!host) throw new Error("no host session was spawned");
      return host.provider;
    },
    createConfigs,
    closedHostIds,
    routeBroker,
    routeRequests,
    routingRegisteredDuringCreate,
    updates,
    owner: { sessionKey: {} },
    triggerAgentClosing: notifyClosing,
  };
}

function startCall(harness: Harness, owner = harness.owner, routed = true) {
  return harness.coordinator.start({
    offerSdp: OFFER_SDP,
    owner,
    emit: (update) => harness.updates.push(update),
    ...(routed ? { sendRouteRequest: (request) => harness.routeRequests.push(request) } : {}),
  });
}

describe("LiveVoiceCoordinator", () => {
  it("spawns a hidden host session and accepts the call when the SDP arrives during start", async () => {
    const harness = createHarness();

    const result = await startCall(harness);

    expect(result).toEqual({
      accepted: true,
      liveSessionId: expect.any(String),
      answerSdp: ANSWER_SDP,
    });
    // Hidden, provider-specific, and deliberately not in a project directory.
    expect(harness.createConfigs).toEqual([
      { provider: "codex", cwd: HOST_CWD, title: "Live Voice host", internal: true },
    ]);
    expect(harness.hosts).toHaveLength(1);
    expect(harness.routingRegisteredDuringCreate).toEqual([true]);
    expect(harness.routeBroker.isRegisteredHost("host-1")).toBe(true);
    expect(harness.provider().startCalls[0]).toMatchObject({
      sdp: OFFER_SDP,
      realtimeSessionId: result.accepted ? result.liveSessionId : "",
    });
    expect(harness.updates.map((update) => update.event.kind)).toEqual(["started"]);
    expect(harness.updates[0]?.seq).toBe(0);
  });

  it("runs the host session in the user's home directory by default", async () => {
    const harness = createHarness({ hostCwd: null });

    expect(await startCall(harness)).toMatchObject({ accepted: true });
    expect(harness.createConfigs[0]?.cwd).toBe(os.homedir());
  });

  it("preserves the legacy local catalog when the owner cannot route across hosts", async () => {
    const harness = createHarness();

    const result = await startCall(harness, harness.owner, false);

    expect(result).toMatchObject({ accepted: true });
    expect(harness.routingRegisteredDuringCreate).toEqual([false]);
    expect(harness.routeBroker.isRegisteredHost("host-1")).toBe(false);
    expect(harness.routeRequests).toEqual([]);
  });

  it("accepts a call when the answer SDP arrives after the start response resolves", async () => {
    const harness = createHarness({ makeProvider: () => createFakeProviderSession() });

    const pending = startCall(harness);
    // Let the host spawn and realtimeStart settle, then deliver the notification.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    harness.provider().emit({ kind: "sdp", sdp: ANSWER_SDP });

    expect(await pending).toEqual({
      accepted: true,
      liveSessionId: expect.any(String),
      answerSdp: ANSWER_SDP,
    });
  });

  it("forwards finalized transcripts with a monotonic seq", async () => {
    const harness = createHarness();
    await startCall(harness);

    harness.provider().emit({ kind: "transcript", role: "user", text: "hello" });
    harness.provider().emit({ kind: "transcript", role: "assistant", text: "hi" });

    expect(harness.updates.map((update) => update.seq)).toEqual([0, 1, 2]);
    expect(harness.updates[1]?.event).toMatchObject({
      kind: "transcript",
      role: "user",
      text: "hello",
    });
    expect(harness.updates[2]?.event).toMatchObject({ kind: "transcript", role: "assistant" });
  });

  it("rejects a second start from the same client with busy", async () => {
    const harness = createHarness();
    await startCall(harness);

    const second = await startCall(harness);

    expect(second).toMatchObject({ accepted: false, errorCode: "busy" });
    // No second host session was spawned for the rejected start.
    expect(harness.hosts).toHaveLength(1);
  });

  it("lets a different client hold its own concurrent call on its own host session", async () => {
    const harness = createHarness();
    const first = await startCall(harness);
    const second = await startCall(harness, { sessionKey: {} });

    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: true });
    expect(harness.hosts.map((host) => host.agentId)).toEqual(["host-1", "host-2"]);
    if (!first.accepted || !second.accepted) throw new Error("expected both calls to be accepted");
    expect(first.liveSessionId).not.toBe(second.liveSessionId);
  });

  it("reports unsupported when the daemon has no provider that can host a call", async () => {
    const harness = createHarness({
      availability: { available: false, error: "codex CLI not installed" },
    });

    expect(await startCall(harness)).toMatchObject({
      accepted: false,
      errorCode: "unsupported",
      errorMessage: expect.stringContaining("codex CLI not installed"),
    });
    // Nothing was spawned, so nothing needs tearing down.
    expect(harness.createConfigs).toEqual([]);
  });

  it("reports unsupported and disposes the host when it lacks the live voice capability", async () => {
    const harness = createHarness({ capabilities: {} });

    expect(await startCall(harness)).toMatchObject({ accepted: false, errorCode: "unsupported" });
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("reports start_failed when the host session cannot be spawned", async () => {
    const harness = createHarness({ createAgentError: new Error("provider launch failed") });

    expect(await startCall(harness)).toMatchObject({
      accepted: false,
      errorCode: "start_failed",
      errorMessage: "provider launch failed",
    });
  });

  it("treats a stop with an unknown liveSessionId as a no-op", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("expected the call to be accepted");

    harness.coordinator.stop({ liveSessionId: "not-the-live-session" });

    expect(harness.coordinator.hasActiveCall(result.liveSessionId)).toBe(true);
    expect(harness.provider().stopCalls).toHaveLength(0);
    expect(harness.closedHostIds).toEqual([]);
    expect(harness.updates.map((update) => update.event.kind)).toEqual(["started"]);
  });

  it("closes with cause requested on a matching stop and tears the host session down", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("expected the call to be accepted");

    harness.coordinator.stop({ liveSessionId: result.liveSessionId });
    // A second stop must not produce a second closed update or a second teardown.
    harness.coordinator.stop({ liveSessionId: result.liveSessionId });

    expect(harness.updates.at(-1)?.event).toMatchObject({ kind: "closed", cause: "requested" });
    expect(harness.updates.filter((update) => update.event.kind === "closed")).toHaveLength(1);
    expect(harness.provider().stopCalls).toHaveLength(1);
    expect(harness.provider().subscriberCount()).toBe(0);
    expect(harness.closedHostIds).toEqual(["host-1"]);
    expect(harness.coordinator.hasActiveCall(result.liveSessionId)).toBe(false);
    expect(harness.routeBroker.isRegisteredHost("host-1")).toBe(false);
  });

  it("tears every call of a session down when the whole client session goes away", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("expected the call to be accepted");

    harness.coordinator.closeForSession(harness.owner.sessionKey);

    expect(harness.coordinator.hasActiveCall(result.liveSessionId)).toBe(false);
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("closes with cause host_session_closed when the host session is torn down mid-call", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("expected the call to be accepted");

    harness.triggerAgentClosing("host-1");

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "host_session_closed",
    });
    expect(harness.coordinator.hasActiveCall(result.liveSessionId)).toBe(false);
    // onAgentClosing fires before the provider session is disposed, so the
    // coordinator still tells codex to end the upstream realtime session.
    expect(harness.provider().stopCalls).toHaveLength(1);
    // And the host teardown that re-enters through onAgentClosing must not loop.
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("ignores a closing agent that is not hosting a call", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("expected the call to be accepted");

    harness.triggerAgentClosing("some-unrelated-agent");

    expect(harness.coordinator.hasActiveCall(result.liveSessionId)).toBe(true);
    expect(harness.updates.map((update) => update.event.kind)).toEqual(["started"]);
  });

  it("closes with cause codex_exit when the provider transport dies mid-call", async () => {
    const harness = createHarness();
    await startCall(harness);

    harness.provider().emit({ kind: "transport_closed", reason: "Codex app-server exited" });

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "codex_exit",
      detail: "Codex app-server exited",
    });
    // The transport is gone; never ask it to stop (that would respawn codex).
    expect(harness.provider().stopCalls).toHaveLength(0);
    // The host session still has to go.
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("closes with cause codex_closed when codex ends the realtime session", async () => {
    const harness = createHarness();
    await startCall(harness);

    harness.provider().emit({ kind: "closed", reason: "client_closed" });

    expect(harness.updates.at(-1)?.event).toMatchObject({
      kind: "closed",
      cause: "codex_closed",
      detail: "client_closed",
    });
    expect(harness.provider().stopCalls).toHaveLength(0);
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("emits a fatal error then closes on a codex realtime error", async () => {
    const harness = createHarness();
    await startCall(harness);

    harness.provider().emit({ kind: "error", message: "invalid_offer" });

    expect(harness.updates.map((update) => update.event.kind)).toEqual([
      "started",
      "error",
      "closed",
    ]);
    expect(harness.updates[1]?.event).toMatchObject({ fatal: true, message: "invalid_offer" });
    expect(harness.updates[2]?.event).toMatchObject({ kind: "closed", cause: "error" });
  });

  it("fails with start_failed and disposes the host when the answer SDP never arrives", async () => {
    const harness = createHarness({
      makeProvider: () => createFakeProviderSession(),
      startSdpTimeoutMs: 5,
    });

    const result = await startCall(harness);

    expect(result).toMatchObject({ accepted: false, errorCode: "start_failed" });
    // The call never went active, so the owner gets no push — only the response.
    expect(harness.updates).toEqual([]);
    expect(harness.provider().subscriberCount()).toBe(0);
    expect(harness.provider().stopCalls).toHaveLength(1);
    expect(harness.closedHostIds).toEqual(["host-1"]);

    // The client is released, so a retry can place a new call.
    const retry = await startCall(harness);
    expect(retry).toMatchObject({ accepted: false, errorCode: "start_failed" });
    expect(harness.hosts).toHaveLength(2);
  });

  it("fails with start_failed when the provider rejects the start request", async () => {
    const harness = createHarness({
      makeProvider: () => createFakeProviderSession({ startError: new Error("realtime disabled") }),
    });

    expect(await startCall(harness)).toMatchObject({
      accepted: false,
      errorCode: "start_failed",
      errorMessage: "realtime disabled",
    });
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("does not resurrect a call closed while the handshake was in flight", async () => {
    const harness = createHarness({
      makeProvider: () =>
        createFakeProviderSession({
          onStart: (emit) => {
            emit({ kind: "sdp", sdp: ANSWER_SDP });
            emit({ kind: "transport_closed", reason: "Codex app-server exited" });
          },
        }),
    });

    const result = await startCall(harness);

    expect(result).toMatchObject({ accepted: false, errorCode: "start_failed" });
    expect(harness.updates).toEqual([]);
    expect(harness.closedHostIds).toEqual(["host-1"]);
  });

  it("disposes a host session that finished spawning after its call was closed", async () => {
    let releaseSpawn: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const harness = createHarness({ createAgentGate: gate });

    const pending = startCall(harness);
    await Promise.resolve();
    expect(harness.routingRegisteredDuringCreate).toEqual([true]);
    // The call exists from the moment it is accepted, so the detach lands while
    // the host is still spawning.
    harness.coordinator.closeForSession(harness.owner.sessionKey);
    releaseSpawn();

    expect(await pending).toMatchObject({ accepted: false, errorCode: "start_failed" });
    expect(harness.closedHostIds).toEqual(["host-1"]);
    expect(harness.updates).toEqual([]);
  });

  it("does not register or spawn a host after the owner closes during availability checking", async () => {
    let releaseAvailability: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAvailability = resolve;
    });
    const harness = createHarness({ availabilityGate: gate });

    const pending = startCall(harness);
    harness.coordinator.closeForSession(harness.owner.sessionKey);
    releaseAvailability();

    expect(await pending).toMatchObject({ accepted: false, errorCode: "start_failed" });
    expect(harness.createConfigs).toEqual([]);
    expect(harness.routingRegisteredDuringCreate).toEqual([]);
    expect(harness.routeBroker.isRegisteredHost("host-1")).toBe(false);
  });

  it("closes every call and host session on dispose", async () => {
    const harness = createHarness();
    const first = await startCall(harness);
    const second = await startCall(harness, { sessionKey: {} });
    if (!first.accepted || !second.accepted) throw new Error("expected both calls to be accepted");

    harness.coordinator.dispose();

    expect(harness.coordinator.hasActiveCall(first.liveSessionId)).toBe(false);
    expect(harness.coordinator.hasActiveCall(second.liveSessionId)).toBe(false);
    expect(harness.closedHostIds).toEqual(["host-1", "host-2"]);
  });

  it("passes the Paseo prompt and snapshot to the provider and suppresses its startup context", async () => {
    const context: LiveVoiceContextProvider = {
      build: async () => ({
        prompt: "daemon prompt",
        initialItems: [{ role: "developer", text: "state snapshot" }],
      }),
    };
    const harness = createHarness({ context });

    await startCall(harness);

    expect(harness.provider().startCalls[0]).toMatchObject({
      prompt: "daemon prompt",
      initialItems: [{ role: "developer", text: "state snapshot" }],
      includeStartupContext: false,
    });
  });

  it("still places the call when building the Paseo context fails", async () => {
    const context: LiveVoiceContextProvider = {
      build: async () => {
        throw new Error("workspace registry unavailable");
      },
    };
    const harness = createHarness({ context });

    expect(await startCall(harness)).toMatchObject({ accepted: true });
    // Falls back to the provider's own context rather than failing the call.
    expect(harness.provider().startCalls[0]?.prompt).toBeUndefined();
    expect(harness.provider().startCalls[0]?.includeStartupContext).toBeUndefined();
  });

  it("omits context fields entirely when no provider is configured", async () => {
    const harness = createHarness();

    await startCall(harness);

    expect(harness.provider().startCalls[0]).not.toHaveProperty("prompt");
    expect(harness.provider().startCalls[0]).not.toHaveProperty("initialItems");
    expect(harness.provider().startCalls[0]).not.toHaveProperty("includeStartupContext");
  });
  it("speaks into a call for its owning client session", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("call was not accepted");

    await expect(
      harness.coordinator.say({
        liveSessionId: result.liveSessionId,
        sessionKey: harness.owner.sessionKey,
        text: "The session finished.",
      }),
    ).resolves.toEqual({ delivered: true });
    expect(harness.provider().appendedText).toEqual([
      { text: "The session finished.", role: "developer" },
    ]);
  });

  it("refuses to speak into a call owned by another client session", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("call was not accepted");

    const otherSession = {};
    await expect(
      harness.coordinator.say({
        liveSessionId: result.liveSessionId,
        sessionKey: otherSession,
        text: "The session finished.",
      }),
    ).resolves.toMatchObject({ delivered: false, errorCode: "unknown_call" });
    expect(harness.provider().appendedText).toEqual([]);
  });

  it("refuses to speak into a call that has already closed", async () => {
    const harness = createHarness();
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("call was not accepted");
    harness.coordinator.stop({ liveSessionId: result.liveSessionId });

    await expect(
      harness.coordinator.say({
        liveSessionId: result.liveSessionId,
        sessionKey: harness.owner.sessionKey,
        text: "The session finished.",
      }),
    ).resolves.toMatchObject({ delivered: false, errorCode: "unknown_call" });
  });

  it("reports a provider failure instead of throwing at the caller", async () => {
    const harness = createHarness({
      makeProvider: () =>
        createFakeProviderSession({
          onStart: (emit) => emit({ kind: "sdp", sdp: ANSWER_SDP }),
          appendTextError: new Error("codex says no"),
        }),
    });
    const result = await startCall(harness);
    if (!result.accepted) throw new Error("call was not accepted");

    await expect(
      harness.coordinator.say({
        liveSessionId: result.liveSessionId,
        sessionKey: harness.owner.sessionKey,
        text: "The session finished.",
      }),
    ).resolves.toMatchObject({ delivered: false, errorCode: "append_failed" });
  });
});
