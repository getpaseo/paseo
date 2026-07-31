import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage, VoiceLiveEvent } from "@getpaseo/protocol/messages";
import { createAudioSessionLease } from "@/audio/audio-session-lease";
import {
  createLiveVoiceRuntime,
  type LiveVoiceDaemonClient,
  type LiveVoiceRuntime,
  type LiveVoiceRuntimeDeps,
} from "./live-voice-runtime";
import type { LiveVoiceSession } from "./live-voice-session";
import type { LiveVoiceCuePlayer } from "./live-voice-cue-player";
import {
  advanceLiveVoiceCueState,
  attachLiveVoiceCues,
  initialLiveVoiceCueState,
} from "./live-voice-cues";

type VoiceLiveUpdateMessage = Extract<SessionOutboundMessage, { type: "voice.live.update" }>;

const SERVER_ID = "host-1";
const LIVE_SESSION_ID = "live-1";

interface Harness {
  runtime: LiveVoiceRuntime;
  cues: string[];
  player: LiveVoiceCuePlayer & { dispose: ReturnType<typeof vi.fn> };
  detach: () => void;
  push(event: VoiceLiveEvent): void;
}

function createHarness(overrides: { isSessionSupported?: boolean } = {}): Harness {
  const subscribers = new Set<(message: VoiceLiveUpdateMessage) => void>();
  let seq = 0;

  const client: LiveVoiceDaemonClient = {
    startLiveVoice: async () => ({ liveSessionId: LIVE_SESSION_ID, answerSdp: "answer" }),
    stopLiveVoice: async () => undefined,
    subscribeUpdates: (handler) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };

  const startSession: LiveVoiceRuntimeDeps["startSession"] = async (options) => {
    const negotiation = await options.negotiate("offer");
    return {
      liveSessionId: negotiation.liveSessionId,
      setMuted: () => {},
      resumeAudio: async () => undefined,
      close: () => {},
    } satisfies LiveVoiceSession;
  };

  const runtime = createLiveVoiceRuntime({
    getClient: () => client,
    startSession,
    isSessionSupported: overrides.isSessionSupported ?? true,
    lease: createAudioSessionLease(),
  });

  const cues: string[] = [];
  const player = {
    play: (cue: string) => {
      cues.push(cue);
    },
    dispose: vi.fn(),
  } as unknown as Harness["player"];

  return {
    runtime,
    cues,
    player,
    detach: attachLiveVoiceCues(runtime, player),
    push: (event) => {
      const message: VoiceLiveUpdateMessage = {
        type: "voice.live.update",
        payload: { liveSessionId: LIVE_SESSION_ID, seq: seq++, event },
      };
      for (const handler of subscribers) {
        handler(message);
      }
    },
  };
}

describe("live voice cue transitions", () => {
  it("chimes once when the call goes active, whatever else the snapshot does", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    // Snapshot churn that is not a connection transition.
    harness.runtime.toggleMute();
    harness.runtime.toggleMute();
    harness.push({ kind: "started" });
    harness.push({ kind: "transcript", role: "user", transcriptId: "t1", text: "hello" });

    expect(harness.cues).toEqual(["connected"]);
  });

  it("chimes once when the user stops the call, despite the stopping→idle pass", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    await harness.runtime.stop();

    expect(harness.cues).toEqual(["connected", "disconnected"]);
  });

  it("chimes when the daemon closes the call", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "closed", cause: "provider_hangup" });

    expect(harness.cues).toEqual(["connected", "disconnected"]);
  });

  it("chimes when a fatal error ends a live call", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "error", code: "provider_error", message: "boom", fatal: true });

    expect(harness.cues).toEqual(["connected", "disconnected"]);
  });

  it("stays silent for a non-fatal error, which leaves the call up", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    harness.push({ kind: "error", code: "transcript_dropped", message: "dropped", fatal: false });

    expect(harness.cues).toEqual(["connected"]);
  });

  it("chimes when the host connection dies under a live call", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    harness.runtime.handleConnectionLost(SERVER_ID);

    expect(harness.cues).toEqual(["connected", "disconnected"]);
  });

  it("stays silent for a start that never connected", async () => {
    const harness = createHarness({ isSessionSupported: false });

    await expect(harness.runtime.start(SERVER_ID)).rejects.toThrow();
    harness.runtime.dismiss();

    expect(harness.cues).toEqual([]);
  });

  it("chimes again for a second call", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    await harness.runtime.stop();
    await harness.runtime.start(SERVER_ID);

    expect(harness.cues).toEqual(["connected", "disconnected", "connected"]);
  });

  it("detaching releases the player and silences later transitions", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID);
    harness.detach();
    await harness.runtime.stop();

    expect(harness.player.dispose).toHaveBeenCalledTimes(1);
    expect(harness.cues).toEqual(["connected"]);
  });

  it("attaching to an already-live call does not chime", async () => {
    const harness = createHarness();
    await harness.runtime.start(SERVER_ID);
    harness.detach();

    const cues: string[] = [];
    const detach = attachLiveVoiceCues(harness.runtime, {
      play: (cue) => cues.push(cue),
      dispose: () => {},
    });
    harness.push({ kind: "transcript", role: "assistant", transcriptId: "t1", text: "hi" });
    expect(cues).toEqual([]);

    await harness.runtime.stop();
    expect(cues).toEqual(["disconnected"]);
    detach();
  });
});

describe("advanceLiveVoiceCueState", () => {
  it("seeds the latch from the phase it attached to", () => {
    expect(initialLiveVoiceCueState("active")).toBe(true);
    expect(initialLiveVoiceCueState("starting")).toBe(false);
    expect(initialLiveVoiceCueState("idle")).toBe(false);
  });

  it("is edge-triggered in both directions", () => {
    expect(advanceLiveVoiceCueState(false, "starting")).toEqual({ state: false, cue: null });
    expect(advanceLiveVoiceCueState(false, "active")).toEqual({ state: true, cue: "connected" });
    expect(advanceLiveVoiceCueState(true, "active")).toEqual({ state: true, cue: null });
    expect(advanceLiveVoiceCueState(true, "stopping")).toEqual({
      state: false,
      cue: "disconnected",
    });
    expect(advanceLiveVoiceCueState(false, "idle")).toEqual({ state: false, cue: null });
    expect(advanceLiveVoiceCueState(false, "error")).toEqual({ state: false, cue: null });
  });
});
