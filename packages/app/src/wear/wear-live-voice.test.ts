import { describe, expect, it } from "vitest";

import type { LiveVoiceAvailability } from "@/live-voice/live-voice-availability-policy";
import type { LiveVoiceSnapshot } from "@/live-voice/live-voice-runtime";
import {
  buildWearLiveVoiceState,
  MAX_LIVE_VOICE_TRANSCRIPT_CHARS,
  MAX_LIVE_VOICE_TRANSCRIPTS,
  stableLiveVoiceKey,
} from "./wear-live-voice";

const NOW = 1_750_000_000_000;

const IDLE: LiveVoiceSnapshot = {
  phase: "idle",
  serverId: null,
  liveSessionId: null,
  sessionMode: null,
  isMuted: false,
  isAudioBlocked: false,
  transcripts: [],
  error: null,
  closedCause: null,
};

function host(serverId: string, label: string) {
  return {
    serverId,
    label,
    connectionStatus: "online" as const,
    version: "0.2.5",
    supportsLiveVoice: true,
  };
}

const AVAILABLE: LiveVoiceAvailability = {
  kind: "available",
  hosts: [host("srv-1", "workstation"), host("srv-2", "laptop")],
};

describe("buildWearLiveVoiceState", () => {
  it("projects a live call with its host label and transcript", () => {
    const state = buildWearLiveVoiceState(
      {
        snapshot: {
          ...IDLE,
          phase: "active",
          serverId: "srv-2",
          liveSessionId: "live-1",
          transcripts: [
            { id: "t1", role: "user", text: "What's running?" },
            { id: "t2", role: "assistant", text: "Three sessions." },
          ],
        },
        availability: AVAILABLE,
      },
      NOW,
    );

    expect(state).toMatchObject({
      v: 1,
      updatedAt: NOW,
      phase: "active",
      serverId: "srv-2",
      hostLabel: "laptop",
      isMuted: false,
      unavailableReason: null,
    });
    expect(state.hosts).toEqual([
      { serverId: "srv-1", label: "workstation" },
      { serverId: "srv-2", label: "laptop" },
    ]);
    expect(state.transcripts).toEqual([
      { id: "t1", role: "user", text: "What's running?" },
      { id: "t2", role: "assistant", text: "Three sessions." },
    ]);
  });

  it("carries the unavailable reason and offers no hosts", () => {
    const state = buildWearLiveVoiceState(
      {
        snapshot: IDLE,
        availability: { kind: "unavailable", reason: "hosts_offline", hosts: [] },
      },
      NOW,
    );

    expect(state.hosts).toEqual([]);
    expect(state.unavailableReason).toBe("hosts_offline");
  });

  it("keeps a live call's host label after that host stops being callable", () => {
    // A host drops out of the callable set the moment it goes offline, but the
    // call's header should still say which machine it was placed on.
    const state = buildWearLiveVoiceState(
      {
        snapshot: { ...IDLE, phase: "error", serverId: "srv-1" },
        availability: {
          kind: "unavailable",
          reason: "hosts_offline",
          hosts: [{ ...host("srv-1", "workstation"), connectionStatus: "offline" }],
        },
      },
      NOW,
    );

    expect(state.hostLabel).toBe("workstation");
    expect(state.hosts).toEqual([]);
  });

  it("collapses whitespace and caps a long turn", () => {
    const state = buildWearLiveVoiceState(
      {
        snapshot: {
          ...IDLE,
          phase: "active",
          transcripts: [
            { id: "t1", role: "assistant", text: `  wrapped\n\n  across   lines  ` },
            { id: "t2", role: "assistant", text: "x".repeat(MAX_LIVE_VOICE_TRANSCRIPT_CHARS + 50) },
          ],
        },
        availability: AVAILABLE,
      },
      NOW,
    );

    expect(state.transcripts[0]?.text).toBe("wrapped across lines");
    expect(state.transcripts[1]?.text).toHaveLength(MAX_LIVE_VOICE_TRANSCRIPT_CHARS);
    expect(state.transcripts[1]?.text.endsWith("…")).toBe(true);
  });

  it("keeps only the newest turns", () => {
    const transcripts = Array.from({ length: MAX_LIVE_VOICE_TRANSCRIPTS + 5 }, (_, index) => ({
      id: `t${index}`,
      role: "assistant" as const,
      text: `turn ${index}`,
    }));

    const state = buildWearLiveVoiceState(
      { snapshot: { ...IDLE, phase: "active", transcripts }, availability: AVAILABLE },
      NOW,
    );

    expect(state.transcripts).toHaveLength(MAX_LIVE_VOICE_TRANSCRIPTS);
    expect(state.transcripts.at(-1)?.id).toBe(`t${MAX_LIVE_VOICE_TRANSCRIPTS + 4}`);
  });

  it("drops a turn the model has not put words in yet", () => {
    const state = buildWearLiveVoiceState(
      {
        snapshot: {
          ...IDLE,
          phase: "active",
          transcripts: [
            { id: "t1", role: "assistant", text: "   " },
            { id: "t2", role: "assistant", text: "Done." },
          ],
        },
        availability: AVAILABLE,
      },
      NOW,
    );

    expect(state.transcripts.map((entry) => entry.id)).toEqual(["t2"]);
  });

  it("flattens the runtime's structured error", () => {
    const state = buildWearLiveVoiceState(
      {
        snapshot: {
          ...IDLE,
          phase: "error",
          serverId: "srv-1",
          error: { code: "mic_busy", message: "Dictation is using the microphone." },
          closedCause: "owner_disconnected",
        },
        availability: AVAILABLE,
      },
      NOW,
    );

    expect(state.errorCode).toBe("mic_busy");
    expect(state.errorMessage).toBe("Dictation is using the microphone.");
    expect(state.closedCause).toBe("owner_disconnected");
  });
});

describe("stableLiveVoiceKey", () => {
  it("ignores updatedAt, which moves on every build", () => {
    const input = { snapshot: { ...IDLE, phase: "active" as const }, availability: AVAILABLE };
    expect(stableLiveVoiceKey(buildWearLiveVoiceState(input, NOW))).toBe(
      stableLiveVoiceKey(buildWearLiveVoiceState(input, NOW + 60_000)),
    );
  });

  it("separates states that differ in anything else", () => {
    const base = buildWearLiveVoiceState(
      { snapshot: { ...IDLE, phase: "active" }, availability: AVAILABLE },
      NOW,
    );
    const muted = buildWearLiveVoiceState(
      { snapshot: { ...IDLE, phase: "active", isMuted: true }, availability: AVAILABLE },
      NOW,
    );
    expect(stableLiveVoiceKey(base)).not.toBe(stableLiveVoiceKey(muted));
  });
});
