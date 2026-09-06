import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SessionOutboundMessage, VoiceLiveEvent } from "@getpaseo/protocol/messages";
import { createAudioSessionLease, type AudioSessionLease } from "@/audio/audio-session-lease";
import {
  createLiveVoiceRuntime,
  LiveVoiceStartError,
  type LiveVoiceDaemonClient,
  type LiveVoiceRuntime,
  type LiveVoiceRuntimeDeps,
} from "./live-voice-runtime";
import type { LiveVoiceSession, StartLiveVoiceSessionOptions } from "./live-voice-session";

type VoiceLiveUpdateMessage = Extract<SessionOutboundMessage, { type: "voice.live.update" }>;

const SERVER_ID = "host-1";
const LIVE_SESSION_ID = "live-1";
const OFFER_SDP = "v=0\r\no=- offer";
const ANSWER_SDP = "v=0\r\no=- answer";

type StartLiveVoiceMock = Mock<LiveVoiceDaemonClient["startLiveVoice"]>;

interface HarnessClient extends LiveVoiceDaemonClient {
  startLiveVoice: StartLiveVoiceMock;
  stopLiveVoice: Mock<LiveVoiceDaemonClient["stopLiveVoice"]>;
}

interface Harness {
  runtime: LiveVoiceRuntime;
  lease: AudioSessionLease;
  client: HarnessClient;
  session: { close: Mock<() => void>; setMuted: Mock<(muted: boolean) => void> };
  /** Options the session module was constructed with, for driving its callbacks. */
  sessionOptions(): StartLiveVoiceSessionOptions;
  /** Push a `voice.live.update` as if it came off the socket. */
  push(event: VoiceLiveEvent, overrides?: { liveSessionId?: string; seq?: number }): void;
  subscriberCount(): number;
  startSession: Mock<LiveVoiceRuntimeDeps["startSession"]>;
  pinConnection: Mock<NonNullable<LiveVoiceRuntimeDeps["pinConnection"]>> | null;
  pinRelease: Mock<() => void>;
}

function createHarness(
  overrides: {
    startLiveVoice?: StartLiveVoiceMock;
    isSessionSupported?: boolean;
    getClient?: LiveVoiceRuntimeDeps["getClient"];
    pinConnection?: "active" | LiveVoiceRuntimeDeps["pinConnection"];
    voice?: string;
    callSettings?: LiveVoiceRuntimeDeps["callSettings"];
    ambientAgentReports?: LiveVoiceRuntimeDeps["ambientAgentReports"];
    assistant?: LiveVoiceRuntimeDeps["assistant"];
  } = {},
): Harness {
  const lease = createAudioSessionLease();
  const subscribers = new Set<(message: VoiceLiveUpdateMessage) => void>();
  let seq = 0;

  const startLiveVoice: StartLiveVoiceMock =
    overrides.startLiveVoice ??
    vi.fn(async () => ({
      liveSessionId: LIVE_SESSION_ID,
      negotiation: { kind: "webrtc_sdp" as const, answerSdp: ANSWER_SDP },
    }));
  const stopLiveVoice: HarnessClient["stopLiveVoice"] = vi.fn(async () => undefined);
  const client: HarnessClient = {
    startLiveVoice,
    stopLiveVoice,
    subscribeUpdates: (handler) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };
  const pinRelease = vi.fn<() => void>();
  let pinConnection: Mock<NonNullable<LiveVoiceRuntimeDeps["pinConnection"]>> | null = null;
  if (overrides.pinConnection === "active") {
    pinConnection = vi.fn(() => ({ client, release: pinRelease }));
  } else if (overrides.pinConnection) {
    pinConnection = vi.fn(overrides.pinConnection);
  }

  const session: Harness["session"] = {
    close: vi.fn<() => void>(),
    setMuted: vi.fn<(muted: boolean) => void>(),
  };
  let capturedOptions: StartLiveVoiceSessionOptions | null = null;
  const startSession: Harness["startSession"] = vi.fn(async (options) => {
    capturedOptions = options;
    // Mirror the real module: negotiate before resolving, so the runtime's
    // handshake ordering is exercised.
    const negotiation = await options.negotiate(OFFER_SDP);
    return {
      liveSessionId: negotiation.liveSessionId,
      setMuted: session.setMuted,
      resumeAudio: async () => undefined,
      close: session.close,
    } satisfies LiveVoiceSession;
  });

  const runtime = createLiveVoiceRuntime({
    getClient: overrides.getClient ?? (() => client),
    ...(pinConnection ? { pinConnection } : {}),
    startSession,
    isSessionSupported: overrides.isSessionSupported ?? true,
    lease,
    ...(overrides.voice ? { voice: { read: () => overrides.voice } } : {}),
    ...(overrides.callSettings ? { callSettings: overrides.callSettings } : {}),
    ...(overrides.assistant ? { assistant: overrides.assistant } : {}),
    ...(overrides.ambientAgentReports
      ? { ambientAgentReports: overrides.ambientAgentReports }
      : {}),
  });

  return {
    runtime,
    lease,
    client,
    session,
    startSession,
    pinConnection,
    pinRelease,
    sessionOptions: () => {
      if (!capturedOptions) {
        throw new Error("startSession was never called");
      }
      return capturedOptions;
    },
    push: (event, options) => {
      const message: VoiceLiveUpdateMessage = {
        type: "voice.live.update",
        payload: {
          liveSessionId: options?.liveSessionId ?? LIVE_SESSION_ID,
          seq: options?.seq ?? seq++,
          event,
        },
      };
      // Handlers may unsubscribe mid-dispatch (a terminal event tears the call
      // down); deleting from a Set during `for…of` is well-defined.
      for (const handler of subscribers) {
        handler(message);
      }
    },
    subscriberCount: () => subscribers.size,
  };
}

describe("live voice runtime", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("starts a call, takes the mic lease, and lands in active", async () => {
    await harness.runtime.start(SERVER_ID);

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("active");
    expect(snapshot.serverId).toBe(SERVER_ID);
    expect(snapshot.liveSessionId).toBe(LIVE_SESSION_ID);
    expect(snapshot.error).toBeNull();
    expect(harness.client.startLiveVoice).toHaveBeenCalledWith({
      negotiation: { kind: "webrtc_sdp", offerSdp: OFFER_SDP },
    });
    expect(harness.lease.current()).toBe("liveVoice");
    expect(harness.runtime.isActiveForServer(SERVER_ID)).toBe(true);
    expect(harness.runtime.isActiveForServer("other-host")).toBe(false);
  });

  it("does not create a daemon call when stopped before negotiation", async () => {
    const entered = Promise.withResolvers<void>();
    const gathered = Promise.withResolvers<void>();
    harness.startSession.mockImplementationOnce(async (options) => {
      entered.resolve();
      await gathered.promise;
      const result = await options.negotiate(OFFER_SDP);
      return {
        ...harness.session,
        liveSessionId: result.liveSessionId,
        resumeAudio: async () => undefined,
      };
    });
    const starting = harness.runtime.start(SERVER_ID);
    await entered.promise;
    await harness.runtime.stop();
    gathered.resolve();
    await expect(starting).resolves.toBeUndefined();
    expect(harness.client.startLiveVoice).not.toHaveBeenCalled();
    expect(harness.lease.current()).toBeNull();
  });

  it("stops the retained daemon call through a replacement client", async () => {
    const stopReplacement = vi.fn(async () => undefined);
    let replacement: LiveVoiceDaemonClient | null = null;
    harness = createHarness({ getClient: () => replacement ?? harness.client });
    await harness.runtime.start(SERVER_ID);
    replacement = { ...harness.client, stopLiveVoice: stopReplacement };
    harness.runtime.handleConnectionLost(SERVER_ID);
    expect(stopReplacement).toHaveBeenCalledWith({ liveSessionId: LIVE_SESSION_ID });
    expect(harness.client.stopLiveVoice).not.toHaveBeenCalled();
  });

  it("applies the selected voice when starting a new call", async () => {
    harness = createHarness({ voice: "juniper" });

    await harness.runtime.start(SERVER_ID);

    expect(harness.client.startLiveVoice).toHaveBeenCalledWith({
      negotiation: { kind: "webrtc_sdp", offerSdp: OFFER_SDP },
      voice: "juniper",
    });
  });

  it("sends the user's prompt configuration with the start request", async () => {
    harness = createHarness({
      callSettings: {
        read: () => ({
          disabledPromptComponents: ["recipes", "speech-style"],
          customVoiceInstructions: "Always answer in one sentence.",
          defaultWorkspaceDirectory: "~/Projects",
          backendModel: "gpt-5.6-sol",
          backendThinkingOptionId: "high",
        }),
      },
    });

    await harness.runtime.start(SERVER_ID);

    expect(harness.client.startLiveVoice).toHaveBeenCalledWith({
      negotiation: { kind: "webrtc_sdp", offerSdp: OFFER_SDP },
      disabledPromptComponents: ["recipes", "speech-style"],
      customVoiceInstructions: "Always answer in one sentence.",
      defaultWorkspaceDirectory: "~/Projects",
      backendModel: "gpt-5.6-sol",
      backendThinkingOptionId: "high",
    });
  });

  it("sends nothing extra when the prompt configuration is default", async () => {
    harness = createHarness({
      callSettings: {
        read: () => ({
          disabledPromptComponents: undefined,
          customVoiceInstructions: undefined,
          defaultWorkspaceDirectory: undefined,
          backendModel: undefined,
          backendThinkingOptionId: undefined,
        }),
      },
    });

    await harness.runtime.start(SERVER_ID);

    expect(harness.client.startLiveVoice).toHaveBeenCalledWith({
      negotiation: { kind: "webrtc_sdp", offerSdp: OFFER_SDP },
    });
  });

  it("omits a persisted voice that the target host does not support", async () => {
    harness = createHarness({ voice: "shimmer" });

    await harness.runtime.start(SERVER_ID);

    expect(harness.client.startLiveVoice).toHaveBeenCalledWith({
      negotiation: { kind: "webrtc_sdp", offerSdp: OFFER_SDP },
    });
  });

  it("records finalized transcripts and replaces by transcript id", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.push({ kind: "started" });
    harness.push({ kind: "transcript", role: "user", transcriptId: "t1", text: "hello" });
    harness.push({ kind: "transcript", role: "assistant", transcriptId: "t2", text: "hi" });
    harness.push({ kind: "transcript", role: "user", transcriptId: "t1", text: "hello there" });

    expect(harness.runtime.getSnapshot().transcripts).toEqual([
      { id: "t1", role: "user", text: "hello there" },
      { id: "t2", role: "assistant", text: "hi" },
    ]);
  });

  it("caps retained transcripts by dropping the oldest entries", async () => {
    await harness.runtime.start(SERVER_ID);

    for (let index = 0; index < 205; index += 1) {
      harness.push({
        kind: "transcript",
        role: "user",
        transcriptId: `t${index}`,
        text: `line ${index}`,
      });
    }

    const transcripts = harness.runtime.getSnapshot().transcripts;
    expect(transcripts).toHaveLength(200);
    expect(transcripts[0]?.id).toBe("t5");
    expect(transcripts[transcripts.length - 1]?.id).toBe("t204");
  });

  it("keeps the daemon's reason clean when the client decorates Error.message", async () => {
    // LiveVoiceStartRejectedError carries the daemon text on `errorMessage` and
    // appends the code to `message`; the snapshot should show the plain reason.
    const rejection = Object.assign(new Error("Out of credits (start_failed)"), {
      errorCode: "start_failed",
      errorMessage: "Out of credits",
    });
    harness = createHarness({
      startLiveVoice: vi.fn(async () => {
        throw rejection;
      }),
    });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toBeInstanceOf(LiveVoiceStartError);

    expect(harness.runtime.getSnapshot().error).toEqual({
      code: "start_failed",
      message: "Out of credits",
    });
  });

  it("reports a daemon rejection through LiveVoiceStartError and releases the lease", async () => {
    const rejection = Object.assign(new Error("Host already has a call"), { errorCode: "busy" });
    harness = createHarness({
      startLiveVoice: vi.fn(async () => {
        throw rejection;
      }),
    });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toBeInstanceOf(LiveVoiceStartError);

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("error");
    expect(snapshot.error).toEqual({ code: "busy", message: "Host already has a call" });
    expect(snapshot.liveSessionId).toBeNull();
    // Everything the runtime owns is handed back on the failure path.
    expect(harness.lease.current()).toBeNull();
    expect(harness.subscriberCount()).toBe(0);
  });

  it("stops the negotiated daemon call when applying its answer fails", async () => {
    harness = createHarness({ pinConnection: "active" });
    harness.startSession.mockImplementationOnce(async (options) => {
      await options.negotiate(OFFER_SDP);
      throw new Error("Invalid remote description");
    });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "start_failed", message: "Invalid remote description" },
    });

    expect(harness.client.stopLiveVoice).toHaveBeenCalledExactlyOnceWith({
      liveSessionId: LIVE_SESSION_ID,
    });
    expect(harness.pinRelease).toHaveBeenCalledOnce();
    expect(harness.lease.current()).toBeNull();
    expect(harness.subscriberCount()).toBe(0);
  });

  it("does not revive a transport that terminates before startup resolves", async () => {
    harness.startSession.mockImplementationOnce(async (options) => {
      const result = await options.negotiate(OFFER_SDP);
      options.onTerminal({ code: "webrtc_failed", message: "Peer failed during startup" });
      options.onAudioBlocked();
      return { ...result, ...harness.session, resumeAudio: async () => undefined };
    });

    await harness.runtime.start(SERVER_ID);

    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "error",
      liveSessionId: null,
      isAudioBlocked: false,
      error: { code: "webrtc_failed", message: "Peer failed during startup" },
    });
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.client.stopLiveVoice).toHaveBeenCalledExactlyOnceWith({
      liveSessionId: LIVE_SESSION_ID,
    });
    expect(harness.lease.current()).toBeNull();
  });

  it("ignores late transport callbacks after a daemon closes the call", async () => {
    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "closed", cause: "provider_closed" });
    const ended = harness.runtime.getSnapshot();

    harness.sessionOptions().onAudioBlocked();
    harness.sessionOptions().onTerminal({ code: "webrtc_failed", message: "Late callback" });

    expect(harness.runtime.getSnapshot()).toBe(ended);
    expect(harness.client.stopLiveVoice).not.toHaveBeenCalled();
  });

  it("releases startup resources if reading call settings fails", async () => {
    harness = createHarness({
      pinConnection: "active",
      callSettings: {
        read: () => {
          throw new Error("Settings unavailable");
        },
      },
    });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "start_failed", message: "Settings unavailable" },
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.lease.current()).toBeNull();
    expect(harness.pinRelease).toHaveBeenCalledOnce();
    expect(harness.subscriberCount()).toBe(0);
  });

  it("releases a refused retry's pin without losing the cancelling call's resources", async () => {
    const negotiated = Promise.withResolvers<void>();
    const finishTransport = Promise.withResolvers<void>();
    harness = createHarness({ pinConnection: "active" });
    harness.startSession.mockImplementationOnce(async (options) => {
      const result = await options.negotiate(OFFER_SDP);
      negotiated.resolve();
      await finishTransport.promise;
      return { ...result, ...harness.session, resumeAudio: async () => undefined };
    });
    const start = harness.runtime.start(SERVER_ID);
    await negotiated.promise;
    await harness.runtime.stop();

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "mic_busy", owner: "liveVoice" },
    });
    expect(harness.pinRelease).toHaveBeenCalledTimes(1);
    expect(harness.lease.current()).toBe("liveVoice");

    finishTransport.resolve();
    await start;

    expect(harness.pinRelease).toHaveBeenCalledTimes(2);
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.lease.current()).toBeNull();
    expect(harness.client.stopLiveVoice).toHaveBeenCalledOnce();
  });

  it("keeps the connection pinned until the daemon acknowledges stop", async () => {
    harness = createHarness({ pinConnection: "active" });
    const stopped = Promise.withResolvers<void>();
    harness.client.stopLiveVoice.mockReturnValueOnce(stopped.promise);
    await harness.runtime.start(SERVER_ID);

    const stop = harness.runtime.stop();
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.lease.current()).toBeNull();
    expect(harness.pinRelease).not.toHaveBeenCalled();
    stopped.resolve();
    await stop;

    expect(harness.pinRelease).toHaveBeenCalledOnce();
  });

  it("retains the microphone lease until native audio teardown completes", async () => {
    const closed = Promise.withResolvers<void>();
    harness.session.close.mockImplementationOnce(() => closed.promise);
    await harness.runtime.start(SERVER_ID);

    const stop = harness.runtime.stop();

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
    expect(harness.lease.current()).toBe("liveVoice");
    expect(harness.lease.acquire("dictation")).toBeNull();

    closed.resolve();
    await stop;

    expect(harness.lease.current()).toBeNull();
  });

  it("still releases the lease and ends the call when local teardown throws", async () => {
    harness.session.close.mockImplementationOnce(() => {
      throw new Error("Native peer already disposed");
    });
    await harness.runtime.start(SERVER_ID);

    await harness.runtime.stop();

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
    expect(harness.lease.current()).toBeNull();
    expect(harness.subscriberCount()).toBe(0);
    expect(harness.client.stopLiveVoice).toHaveBeenCalledOnce();
  });

  it("does not enable ambient reports when a closed push preceded the start response", async () => {
    const enable = vi.fn(async () => undefined);
    harness = createHarness({
      ambientAgentReports: {
        read: () => ({ enabled: true, guidance: undefined }),
        enable,
        disable: async () => undefined,
      },
      startLiveVoice: vi.fn(async () => {
        harness.push({ kind: "closed", cause: "provider_closed" });
        return {
          liveSessionId: LIVE_SESSION_ID,
          negotiation: { kind: "webrtc_sdp", answerSdp: ANSWER_SDP },
        };
      }),
    });

    await harness.runtime.start(SERVER_ID);

    expect(enable).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot().phase).toBe("idle");
  });

  it("ignores repeated and out-of-order updates within the same call", async () => {
    await harness.runtime.start(SERVER_ID);
    harness.push(
      { kind: "transcript", role: "user", transcriptId: "t1", text: "latest" },
      { seq: 5 },
    );
    harness.push(
      { kind: "transcript", role: "user", transcriptId: "t1", text: "older" },
      { seq: 4 },
    );
    harness.push({ kind: "closed", cause: "provider_closed" }, { seq: 5 });

    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "active",
      transcripts: [{ id: "t1", role: "user", text: "latest" }],
    });
  });

  it("refuses to start while another owner holds the mic lease", async () => {
    const other = harness.lease.acquire("dictation");
    expect(other).not.toBeNull();

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "mic_busy", owner: "dictation" },
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    // The incumbent keeps the mic; a refusal never interrupts.
    expect(harness.lease.current()).toBe("dictation");
    expect(harness.runtime.getSnapshot().phase).toBe("error");
  });

  it("refuses to start when the platform has no WebRTC transport", async () => {
    harness = createHarness({ isSessionSupported: false });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "unsupported" },
    });
    expect(harness.lease.current()).toBeNull();
  });

  it("refuses to start when the host is not connected", async () => {
    harness = createHarness({ getClient: () => null });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "not_connected" },
    });
    expect(harness.lease.current()).toBeNull();
  });

  it("requires an exact connection pin when the host runtime supports pinning", async () => {
    const getClient = vi.fn(() => harness.client);
    harness = createHarness({
      getClient,
      pinConnection: () => null,
    });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "not_connected" },
    });

    expect(harness.pinConnection).toHaveBeenCalledWith(SERVER_ID);
    expect(getClient).not.toHaveBeenCalled();
    expect(harness.client.startLiveVoice).not.toHaveBeenCalled();
  });

  it("pins the negotiated daemon client until the call ends", async () => {
    harness = createHarness({ pinConnection: "active" });

    await harness.runtime.start(SERVER_ID);

    expect(harness.pinConnection).toHaveBeenCalledWith(SERVER_ID);
    expect(harness.pinRelease).not.toHaveBeenCalled();

    await harness.runtime.stop();

    expect(harness.client.stopLiveVoice).toHaveBeenCalledWith({
      liveSessionId: LIVE_SESSION_ID,
    });
    expect(harness.pinRelease).toHaveBeenCalledOnce();
  });

  it("releases the connection pin when daemon negotiation fails", async () => {
    harness = createHarness({
      pinConnection: "active",
      startLiveVoice: vi.fn(async () => {
        throw Object.assign(new Error("no call"), { errorCode: "busy" });
      }),
    });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toBeInstanceOf(LiveVoiceStartError);

    expect(harness.pinRelease).toHaveBeenCalledOnce();
  });

  it("drops updates whose liveSessionId belongs to another call", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.push(
      { kind: "transcript", role: "user", transcriptId: "stale", text: "not ours" },
      { liveSessionId: "some-other-call" },
    );
    harness.push({ kind: "closed", cause: "requested" }, { liveSessionId: "some-other-call" });

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.transcripts).toEqual([]);
    expect(snapshot.phase).toBe("active");
    expect(snapshot.liveSessionId).toBe(LIVE_SESSION_ID);
  });

  it("tears everything down on a closed update without sending a stop", async () => {
    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "transcript", role: "user", transcriptId: "t1", text: "hello" });

    harness.push({ kind: "closed", cause: "provider_exit", detail: "child died" });

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.liveSessionId).toBeNull();
    expect(snapshot.closedCause).toBe("provider_exit");
    // Transcripts survive the close so the user can still read the call.
    expect(snapshot.transcripts).toHaveLength(1);
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.lease.current()).toBeNull();
    expect(harness.subscriberCount()).toBe(0);
    expect(harness.client.stopLiveVoice).not.toHaveBeenCalled();
  });

  it("clears a terminal ended state on dismiss()", async () => {
    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "transcript", role: "user", transcriptId: "t1", text: "hello" });
    harness.push({ kind: "closed", cause: "provider_exit" });

    harness.runtime.dismiss();

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.closedCause).toBeNull();
    expect(snapshot.transcripts).toEqual([]);
    expect(snapshot.error).toBeNull();
  });

  it("clears a start failure on dismiss()", async () => {
    harness = createHarness({
      startLiveVoice: vi.fn(async () => {
        throw Object.assign(new Error("no"), { errorCode: "start_failed" });
      }),
    });
    await harness.runtime.start(SERVER_ID).catch(() => undefined);
    expect(harness.runtime.getSnapshot().phase).toBe("error");

    harness.runtime.dismiss();

    expect(harness.runtime.getSnapshot()).toMatchObject({ phase: "idle", error: null });
  });

  it("ignores dismiss() while a call is live", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.runtime.dismiss();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "active",
      liveSessionId: LIVE_SESSION_ID,
    });
    expect(harness.lease.current()).toBe("liveVoice");
  });

  it("goes to error on a fatal error update and keeps that error across the close", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.push({ kind: "error", code: "provider_error", message: "model died", fatal: true });
    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "provider_error", message: "model died" },
      liveSessionId: null,
    });
    expect(harness.lease.current()).toBeNull();

    // The trailing `closed` is now stale (we already dropped our session id), so
    // it must not downgrade the error into a plain "call ended".
    harness.push({ kind: "closed", cause: "error" });
    expect(harness.runtime.getSnapshot().phase).toBe("error");
  });

  it("keeps the call up on a non-fatal error update", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.push({ kind: "error", code: "transient", message: "hiccup", fatal: false });

    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "active",
      error: { code: "transient", message: "hiccup" },
      liveSessionId: LIVE_SESSION_ID,
    });
    expect(harness.lease.current()).toBe("liveVoice");
  });

  it("cleans up locally and sends the stop RPC on stop()", async () => {
    await harness.runtime.start(SERVER_ID);
    await harness.runtime.stop();

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.lease.current()).toBeNull();
    expect(harness.subscriberCount()).toBe(0);
    expect(harness.client.stopLiveVoice).toHaveBeenCalledWith({
      liveSessionId: LIVE_SESSION_ID,
    });
  });

  it("still reaches idle when the stop RPC fails", async () => {
    await harness.runtime.start(SERVER_ID);
    harness.client.stopLiveVoice.mockRejectedValueOnce(new Error("socket gone"));

    await harness.runtime.stop();

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
    expect(harness.lease.current()).toBeNull();
  });

  it("toggles mute only while active", async () => {
    harness.runtime.toggleMute();
    expect(harness.session.setMuted).not.toHaveBeenCalled();

    await harness.runtime.start(SERVER_ID);
    harness.runtime.toggleMute();
    expect(harness.session.setMuted).toHaveBeenLastCalledWith(true);
    expect(harness.runtime.getSnapshot().isMuted).toBe(true);

    harness.runtime.toggleMute();
    expect(harness.session.setMuted).toHaveBeenLastCalledWith(false);
    expect(harness.runtime.getSnapshot().isMuted).toBe(false);
  });

  it("surfaces and clears the autoplay-blocked state", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.sessionOptions().onAudioBlocked();
    expect(harness.runtime.getSnapshot().isAudioBlocked).toBe(true);

    harness.sessionOptions().onAudioResumed();
    expect(harness.runtime.getSnapshot().isAudioBlocked).toBe(false);
  });

  it("treats a terminal transport transition as an error and tells the daemon", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.sessionOptions().onTerminal({ code: "webrtc_failed", message: "connection failed" });

    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "webrtc_failed", message: "connection failed" },
      liveSessionId: null,
    });
    expect(harness.lease.current()).toBeNull();
    expect(harness.client.stopLiveVoice).toHaveBeenCalledWith({
      liveSessionId: LIVE_SESSION_ID,
    });
  });

  it("refuses a second concurrent start", async () => {
    await harness.runtime.start(SERVER_ID);

    await expect(harness.runtime.start("other-host")).rejects.toMatchObject({
      info: { code: "already_active" },
    });
    // The live call is untouched.
    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "active",
      serverId: SERVER_ID,
      liveSessionId: LIVE_SESSION_ID,
    });
  });

  it("tears the call down and frees the mic when the daemon connection is lost", async () => {
    await harness.runtime.start(SERVER_ID);
    expect(harness.lease.current()).toBe("liveVoice");

    harness.runtime.handleConnectionLost(SERVER_ID);

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.liveSessionId).toBeNull();
    expect(snapshot.closedCause).toBe("owner_disconnected");
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    // The whole point: the microphone must not stay locked out.
    expect(harness.lease.current()).toBeNull();
    expect(harness.client.stopLiveVoice).toHaveBeenCalledWith({ liveSessionId: LIVE_SESSION_ID });
  });

  it("ignores a connection loss for a different host", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.runtime.handleConnectionLost("some-other-server");

    expect(harness.runtime.getSnapshot().phase).toBe("active");
    expect(harness.session.close).not.toHaveBeenCalled();
    expect(harness.lease.current()).toBe("liveVoice");
  });

  it("preserves a terminal error when the host later disconnects", async () => {
    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "error", code: "provider_error", message: "model died", fatal: true });

    harness.runtime.handleConnectionLost(SERVER_ID);

    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "provider_error", message: "model died" },
      closedCause: null,
    });
  });

  it("does not revive a call when a start resolves after its connection was lost", async () => {
    let resolveNegotiation: (value: {
      liveSessionId: string;
      negotiation: { kind: "webrtc_sdp"; answerSdp: string };
    }) => void = () => undefined;
    harness = createHarness({
      startLiveVoice: vi.fn(
        () =>
          new Promise<{
            liveSessionId: string;
            negotiation: { kind: "webrtc_sdp"; answerSdp: string };
          }>((resolve) => {
            resolveNegotiation = resolve;
          }),
      ),
    });

    const startPromise = harness.runtime.start(SERVER_ID);
    await vi.waitFor(() => expect(harness.startSession).toHaveBeenCalled());
    harness.runtime.handleConnectionLost(SERVER_ID);

    resolveNegotiation({
      liveSessionId: LIVE_SESSION_ID,
      negotiation: { kind: "webrtc_sdp", answerSdp: ANSWER_SDP },
    });
    await startPromise.catch(() => undefined);

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
    expect(harness.lease.current()).toBeNull();
    expect(harness.session.close).toHaveBeenCalled();
  });

  it("holds the mic lease through a stop() that lands mid-negotiation", async () => {
    let resolveNegotiation: (value: {
      liveSessionId: string;
      negotiation: { kind: "webrtc_sdp"; answerSdp: string };
    }) => void = () => undefined;
    harness = createHarness({
      pinConnection: "active",
      startLiveVoice: vi.fn(
        () =>
          new Promise<{
            liveSessionId: string;
            negotiation: { kind: "webrtc_sdp"; answerSdp: string };
          }>((resolve) => {
            resolveNegotiation = resolve;
          }),
      ),
    });

    const startPromise = harness.runtime.start(SERVER_ID);
    await vi.waitFor(() => expect(harness.startSession).toHaveBeenCalled());

    await harness.runtime.stop();
    // The in-flight session still has the microphone physically open, so the
    // lease must not be released to another owner until that session settles.
    expect(harness.lease.current()).toBe("liveVoice");
    expect(harness.lease.acquire("dictation")).toBeNull();
    expect(harness.pinRelease).not.toHaveBeenCalled();

    resolveNegotiation({
      liveSessionId: LIVE_SESSION_ID,
      negotiation: { kind: "webrtc_sdp", answerSdp: ANSWER_SDP },
    });
    await startPromise;

    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.lease.current()).toBeNull();
    expect(harness.pinRelease).toHaveBeenCalledOnce();
    expect(harness.runtime.getSnapshot().phase).toBe("idle");
  });

  it("applies a `closed` push that raced ahead of the start response", async () => {
    let pushEarly: (() => void) | null = null;
    harness = createHarness({
      startLiveVoice: vi.fn(async () => {
        // Fire the terminal push while the start request is still in flight, so
        // the runtime has no liveSessionId to match against yet.
        pushEarly?.();
        return {
          liveSessionId: LIVE_SESSION_ID,
          negotiation: { kind: "webrtc_sdp" as const, answerSdp: ANSWER_SDP },
        };
      }),
    });
    pushEarly = () => harness.push({ kind: "closed", cause: "provider_closed" });

    await harness.runtime.start(SERVER_ID);

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.closedCause).toBe("provider_closed");
    expect(snapshot.liveSessionId).toBeNull();
    expect(harness.lease.current()).toBeNull();
  });

  it("notifies subscribers on every published transition", async () => {
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    await harness.runtime.start(SERVER_ID);
    expect(listener).toHaveBeenCalled();

    const beforeUnsubscribe = listener.mock.calls.length;
    unsubscribe();
    harness.push({ kind: "transcript", role: "user", transcriptId: "t1", text: "hello" });
    expect(listener.mock.calls.length).toBe(beforeUnsubscribe);
  });
});

describe("Live Voice runtime assistants", () => {
  const ASSISTANT_ID = "ast_" + "a".repeat(32);
  const callSettings: LiveVoiceRuntimeDeps["callSettings"] = {
    read: () => ({
      disabledPromptComponents: ["recipes"],
      customVoiceInstructions: "Be brief.",
      defaultWorkspaceDirectory: "~/Projects",
      backendModel: "gpt-5",
      backendThinkingOptionId: "high",
    }),
  };

  it("rejects unavailable assistants before acquiring call resources", async () => {
    const harness = createHarness({
      pinConnection: "active",
      assistant: {
        read: () => {
          throw new LiveVoiceStartError({ code: "unsupported", message: null });
        },
      },
    });
    await expect(harness.runtime.start(SERVER_ID)).rejects.toMatchObject({
      info: { code: "unsupported" },
    });
    expect(harness.lease.current()).toBeNull();
    expect(harness.pinConnection).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.client.startLiveVoice).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "unsupported" },
    });
  });

  it("attaches the selected assistant and leaves its settings to the record", async () => {
    const listVoices = vi.fn(async () => ["juniper"]);
    const harness = createHarness({
      voice: "juniper",
      callSettings,
      assistant: { read: (serverId) => (serverId === SERVER_ID ? ASSISTANT_ID : undefined) },
    });
    harness.client.listLiveVoiceVoices = listVoices;

    await harness.runtime.start(SERVER_ID);

    expect(harness.client.startLiveVoice).toHaveBeenCalledTimes(1);
    const input = harness.client.startLiveVoice.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      assistantId: ASSISTANT_ID,
      disabledPromptComponents: ["recipes"],
      defaultWorkspaceDirectory: "~/Projects",
    });
    // Voice, instructions, and backend settings are the assistant's own.
    expect(input).not.toHaveProperty("voice");
    expect(input).not.toHaveProperty("customVoiceInstructions");
    expect(input).not.toHaveProperty("backendModel");
    expect(input).not.toHaveProperty("backendThinkingOptionId");
    expect(listVoices).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot()).toMatchObject({
      phase: "active",
      assistantId: ASSISTANT_ID,
    });
  });

  it("keeps the legacy per-call fields when no assistant is selected", async () => {
    const harness = createHarness({
      voice: "juniper",
      callSettings,
      assistant: { read: () => undefined },
    });

    await harness.runtime.start(SERVER_ID);

    const input = harness.client.startLiveVoice.mock.calls[0]?.[0];
    expect(input).not.toHaveProperty("assistantId");
    expect(input).toMatchObject({
      voice: "juniper",
      customVoiceInstructions: "Be brief.",
      backendModel: "gpt-5",
      backendThinkingOptionId: "high",
    });
    expect(harness.runtime.getSnapshot().assistantId).toBeNull();
  });

  it("reads the selection once per start, not from the snapshot of an earlier call", async () => {
    let selected: string | undefined = ASSISTANT_ID;
    const harness = createHarness({ assistant: { read: () => selected } });

    await harness.runtime.start(SERVER_ID);
    expect(harness.runtime.getSnapshot().assistantId).toBe(ASSISTANT_ID);
    await harness.runtime.stop();
    expect(harness.runtime.getSnapshot().assistantId).toBeNull();

    selected = undefined;
    await harness.runtime.start(SERVER_ID);
    expect(harness.client.startLiveVoice.mock.calls[1]?.[0]).not.toHaveProperty("assistantId");
    expect(harness.runtime.getSnapshot().assistantId).toBeNull();
  });
});
