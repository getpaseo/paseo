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
  push(event: VoiceLiveEvent, overrides?: { liveSessionId?: string }): void;
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
  } = {},
): Harness {
  const lease = createAudioSessionLease();
  const subscribers = new Set<(message: VoiceLiveUpdateMessage) => void>();
  let seq = 0;

  const startLiveVoice: StartLiveVoiceMock =
    overrides.startLiveVoice ??
    vi.fn(async () => ({ liveSessionId: LIVE_SESSION_ID, answerSdp: ANSWER_SDP }));
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
          seq: seq++,
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
    expect(snapshot.sessionMode).toBe("background");
    expect(snapshot.liveSessionId).toBe(LIVE_SESSION_ID);
    expect(snapshot.error).toBeNull();
    expect(harness.client.startLiveVoice).toHaveBeenCalledWith({
      offerSdp: OFFER_SDP,
    });
    expect(harness.sessionOptions().mode).toBe("background");
    expect(harness.lease.current()).toBe("liveVoice");
    expect(harness.runtime.isActiveForServer(SERVER_ID)).toBe(true);
    expect(harness.runtime.isActiveForServer("other-host")).toBe(false);
  });

  it("passes an explicit foreground mode to the transport and exposes it in the snapshot", async () => {
    await harness.runtime.start(SERVER_ID, "foreground");

    expect(harness.runtime.getSnapshot().sessionMode).toBe("foreground");
    expect(harness.sessionOptions().mode).toBe("foreground");
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

    harness.push({ kind: "closed", cause: "codex_exit", detail: "child died" });

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.liveSessionId).toBeNull();
    expect(snapshot.closedCause).toBe("codex_exit");
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
    harness.push({ kind: "closed", cause: "codex_exit" });

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
    // The socket is gone and the daemon already released its side.
    expect(harness.client.stopLiveVoice).not.toHaveBeenCalled();
  });

  it("ignores a connection loss for a different host", async () => {
    await harness.runtime.start(SERVER_ID);

    harness.runtime.handleConnectionLost("some-other-server");

    expect(harness.runtime.getSnapshot().phase).toBe("active");
    expect(harness.session.close).not.toHaveBeenCalled();
    expect(harness.lease.current()).toBe("liveVoice");
  });

  it("does not revive a call when a start resolves after its connection was lost", async () => {
    let resolveNegotiation: (value: { liveSessionId: string; answerSdp: string }) => void = () =>
      undefined;
    harness = createHarness({
      startLiveVoice: vi.fn(
        () =>
          new Promise<{ liveSessionId: string; answerSdp: string }>((resolve) => {
            resolveNegotiation = resolve;
          }),
      ),
    });

    const startPromise = harness.runtime.start(SERVER_ID);
    await vi.waitFor(() => expect(harness.startSession).toHaveBeenCalled());
    harness.runtime.handleConnectionLost(SERVER_ID);

    resolveNegotiation({ liveSessionId: LIVE_SESSION_ID, answerSdp: ANSWER_SDP });
    await startPromise.catch(() => undefined);

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
    expect(harness.lease.current()).toBeNull();
    expect(harness.session.close).toHaveBeenCalled();
  });

  it("holds the mic lease through a stop() that lands mid-negotiation", async () => {
    let resolveNegotiation: (value: { liveSessionId: string; answerSdp: string }) => void = () =>
      undefined;
    harness = createHarness({
      pinConnection: "active",
      startLiveVoice: vi.fn(
        () =>
          new Promise<{ liveSessionId: string; answerSdp: string }>((resolve) => {
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

    resolveNegotiation({ liveSessionId: LIVE_SESSION_ID, answerSdp: ANSWER_SDP });
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
        return { liveSessionId: LIVE_SESSION_ID, answerSdp: ANSWER_SDP };
      }),
    });
    pushEarly = () => harness.push({ kind: "closed", cause: "codex_closed" });

    await harness.runtime.start(SERVER_ID);

    const snapshot = harness.runtime.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.closedCause).toBe("codex_closed");
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
