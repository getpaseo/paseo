import { describe, expect, it, vi } from "vitest";
import type { SessionOutboundMessage, VoiceLiveEvent } from "@getpaseo/protocol/messages";
import { createAudioSessionLease } from "@/audio/audio-session-lease";
import {
  createLiveVoiceRuntime,
  type LiveVoiceDaemonClient,
  type LiveVoiceRuntime,
  type LiveVoiceRuntimeDeps,
  type LiveVoiceSnapshot,
} from "./live-voice-runtime";
import type { LiveVoiceSession } from "./live-voice-session";
import type { LiveVoiceBackgroundCallAction } from "./background-call-lifetime";
import {
  advanceLiveVoiceNotificationState,
  attachLiveVoiceCallNotification,
  initialLiveVoiceNotificationState,
  type LiveVoiceCallNotificationPresenter,
  type LiveVoiceNotificationUpdate,
} from "./live-voice-call-notification";

type VoiceLiveUpdateMessage = Extract<SessionOutboundMessage, { type: "voice.live.update" }>;

const SERVER_ID = "host-1";
const LIVE_SESSION_ID = "live-1";

interface Harness {
  runtime: LiveVoiceRuntime;
  updates: LiveVoiceNotificationUpdate[];
  setMuted: ReturnType<typeof vi.fn>;
  stopLiveVoice: ReturnType<typeof vi.fn>;
  press(action: LiveVoiceBackgroundCallAction): void;
  detach: () => void;
  push(event: VoiceLiveEvent): void;
}

function createHarness(): Harness {
  const subscribers = new Set<(message: VoiceLiveUpdateMessage) => void>();
  let seq = 0;

  const stopLiveVoice = vi.fn(async () => undefined);
  const client: LiveVoiceDaemonClient = {
    startLiveVoice: async () => ({ liveSessionId: LIVE_SESSION_ID, answerSdp: "answer" }),
    stopLiveVoice,
    subscribeUpdates: (handler) => {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
  };

  const setMuted = vi.fn();
  const startSession: LiveVoiceRuntimeDeps["startSession"] = async (options) => {
    const negotiation = await options.negotiate("offer");
    return {
      liveSessionId: negotiation.liveSessionId,
      setMuted,
      resumeAudio: async () => undefined,
      close: () => {},
    } satisfies LiveVoiceSession;
  };

  const runtime = createLiveVoiceRuntime({
    getClient: () => client,
    startSession,
    isSessionSupported: true,
    lease: createAudioSessionLease(),
  });

  const updates: LiveVoiceNotificationUpdate[] = [];
  let pressListener: ((action: LiveVoiceBackgroundCallAction) => void) | null = null;
  const presenter: LiveVoiceCallNotificationPresenter = {
    update: (params) => {
      updates.push(params);
    },
    subscribeActions: (listener) => {
      pressListener = listener;
      return () => {
        pressListener = null;
      };
    },
  };

  return {
    runtime,
    updates,
    setMuted,
    stopLiveVoice,
    press: (action) => pressListener?.(action),
    detach: attachLiveVoiceCallNotification(runtime, presenter),
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

describe("live voice notification state", () => {
  const activeSnapshot: LiveVoiceSnapshot = {
    phase: "active",
    serverId: SERVER_ID,
    liveSessionId: LIVE_SESSION_ID,
    sessionMode: "background",
    isMuted: false,
    isAudioBlocked: false,
    transcripts: [],
    error: null,
    closedCause: null,
  };

  it("pushes once on the first active snapshot, confirming the service default", () => {
    const first = advanceLiveVoiceNotificationState(initialLiveVoiceNotificationState, {
      ...activeSnapshot,
    });

    expect(first.update).toEqual({ isMuted: false });
    expect(first.state.isPresented).toBe(true);
  });

  it("stays silent while only unrelated snapshot fields change", () => {
    const first = advanceLiveVoiceNotificationState(initialLiveVoiceNotificationState, {
      ...activeSnapshot,
    });
    const second = advanceLiveVoiceNotificationState(first.state, {
      ...activeSnapshot,
      isAudioBlocked: true,
      transcripts: [{ id: "t1", role: "user", text: "hi" }],
    });

    expect(second.update).toBeNull();
  });

  it("pushes on a mute change and again when it flips back", () => {
    const first = advanceLiveVoiceNotificationState(initialLiveVoiceNotificationState, {
      ...activeSnapshot,
    });
    const muted = advanceLiveVoiceNotificationState(first.state, {
      ...activeSnapshot,
      isMuted: true,
    });
    const unmuted = advanceLiveVoiceNotificationState(muted.state, {
      ...activeSnapshot,
      isMuted: false,
    });

    expect(muted.update).toEqual({ isMuted: true });
    expect(unmuted.update).toEqual({ isMuted: false });
  });

  it("never presents for a foreground call, which has no notification to update", () => {
    const result = advanceLiveVoiceNotificationState(initialLiveVoiceNotificationState, {
      ...activeSnapshot,
      sessionMode: "foreground",
    });

    expect(result.update).toBeNull();
    expect(result.state.isPresented).toBe(false);
  });

  it("resets when the call ends so the next call pushes its own initial state", () => {
    const first = advanceLiveVoiceNotificationState(initialLiveVoiceNotificationState, {
      ...activeSnapshot,
      isMuted: true,
    });
    const ended = advanceLiveVoiceNotificationState(first.state, {
      ...activeSnapshot,
      phase: "idle",
      isMuted: true,
    });
    const next = advanceLiveVoiceNotificationState(ended.state, {
      ...activeSnapshot,
      isMuted: true,
    });

    expect(ended.update).toBeNull();
    expect(ended.state).toEqual(initialLiveVoiceNotificationState);
    expect(next.update).toEqual({ isMuted: true });
  });
});

describe("live voice notification binding", () => {
  it("pushes mute state to the notification of a background call", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID, "background");
    harness.runtime.toggleMute();

    expect(harness.updates).toEqual([{ isMuted: false }, { isMuted: true }]);
  });

  it("leaves a foreground call's notification alone", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID, "foreground");
    harness.runtime.toggleMute();

    expect(harness.updates).toEqual([]);
  });

  it("mutes the call when the notification's mute button is pressed", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID, "background");
    harness.press("toggleMute");

    expect(harness.runtime.getSnapshot().isMuted).toBe(true);
    expect(harness.setMuted).toHaveBeenCalledWith(true);
  });

  it("ends the call when the notification's end button is pressed", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID, "background");
    harness.press("end");
    await vi.waitFor(() => expect(harness.stopLiveVoice).toHaveBeenCalled());

    expect(harness.runtime.getSnapshot().phase).toBe("idle");
  });

  it("ignores a button press that races the call ending", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID, "background");
    harness.push({ kind: "closed", cause: "provider_hangup" });
    harness.stopLiveVoice.mockClear();
    harness.press("end");
    harness.press("toggleMute");

    expect(harness.stopLiveVoice).not.toHaveBeenCalled();
    expect(harness.setMuted).not.toHaveBeenCalled();
  });

  it("stops responding to buttons once detached", async () => {
    const harness = createHarness();

    await harness.runtime.start(SERVER_ID, "background");
    harness.detach();
    harness.press("toggleMute");

    expect(harness.runtime.getSnapshot().isMuted).toBe(false);
  });
});
