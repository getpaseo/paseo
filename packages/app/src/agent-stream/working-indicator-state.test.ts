import { describe, expect, it } from "vitest";

import {
  formatStallDuration,
  resolveIdleMs,
  resolveWorkingIndicatorActivity,
  WORKING_INDICATOR_STALL_THRESHOLD_MS,
  type WorkingIndicatorActivity,
} from "./working-indicator-state";

function resolve(
  overrides: Partial<Parameters<typeof resolveWorkingIndicatorActivity>[0]> = {},
): WorkingIndicatorActivity {
  return resolveWorkingIndicatorActivity({
    idleMs: 0,
    activeTurnOutputTokens: undefined,
    hasPendingPermission: false,
    isConnected: true,
    isDirectoryFresh: true,
    ...overrides,
  });
}

describe("resolveWorkingIndicatorActivity", () => {
  it("defaults to the threshold constant", () => {
    expect(WORKING_INDICATOR_STALL_THRESHOLD_MS).toBe(120_000);
  });

  describe("tokens", () => {
    it("shows nothing when the provider reports no count", () => {
      expect(resolve()).toEqual({});
    });

    it("shows nothing for a zero count", () => {
      // A turn that has produced nothing yet should not render "0 tokens".
      expect(resolve({ activeTurnOutputTokens: 0 })).toEqual({});
    });

    it("shows a positive count", () => {
      expect(resolve({ activeTurnOutputTokens: 1_234 })).toEqual({ outputTokens: 1_234 });
    });
  });

  describe("stall", () => {
    it("does not stall below the threshold", () => {
      expect(resolve({ idleMs: WORKING_INDICATOR_STALL_THRESHOLD_MS - 1 })).toEqual({});
    });

    it("stalls exactly at the threshold", () => {
      expect(resolve({ idleMs: WORKING_INDICATOR_STALL_THRESHOLD_MS })).toEqual({
        stalledIdleMs: WORKING_INDICATOR_STALL_THRESHOLD_MS,
      });
    });

    it("stalls above the threshold", () => {
      expect(resolve({ idleMs: 300_000 })).toEqual({ stalledIdleMs: 300_000 });
    });

    it("honours an injected threshold", () => {
      expect(resolve({ idleMs: 3_000, stallThresholdMs: 2_000 })).toEqual({
        stalledIdleMs: 3_000,
      });
    });

    it("keeps the token count alongside the stall notice", () => {
      // The two slots are independent: how much output is at stake is exactly what the reader
      // needs in order to decide whether to interrupt a stalled turn.
      expect(resolve({ idleMs: 300_000, activeTurnOutputTokens: 1_234 })).toEqual({
        outputTokens: 1_234,
        stalledIdleMs: 300_000,
      });
    });

    it("never claims a stall when the idle duration is unknown", () => {
      // Also the shape a daemon too old to measure idleness arrives in: the caller reports the
      // missing capability as an absent duration rather than a second code path.
      expect(resolve({ idleMs: undefined, activeTurnOutputTokens: 500 })).toEqual({
        outputTokens: 500,
      });
    });

    it("never claims a stall while a permission is pending", () => {
      // Covers tool prompts, question cards and plan approvals — all leave the agent running.
      expect(resolve({ idleMs: 300_000, hasPendingPermission: true })).toEqual({});
    });

    it("never claims a stall while disconnected", () => {
      expect(resolve({ idleMs: 300_000, isConnected: false })).toEqual({});
    });

    it("never claims a stall while the directory is stale", () => {
      // The replica cache restores `running` plus a stale activity value — on a cold start and
      // equally on the refetch that follows a reconnect.
      expect(resolve({ idleMs: 300_000, isDirectoryFresh: false })).toEqual({});
    });

    it("still shows the token count while suppressed", () => {
      expect(
        resolve({ idleMs: 300_000, hasPendingPermission: true, activeTurnOutputTokens: 42 }),
      ).toEqual({ outputTokens: 42 });
    });
  });
});

describe("formatStallDuration", () => {
  it("floors to the minute past a minute", () => {
    expect(formatStallDuration(4 * 60_000 + 37_000)).toBe("4m");
  });

  it("reads as hours and minutes past an hour, never as 74 minutes", () => {
    expect(formatStallDuration(74 * 60_000 + 20_000)).toBe("1h 14m");
  });

  it("passes sub-minute durations through unfloored", () => {
    // Unreachable at the shipped 2-minute threshold, but the e2e override lowers it and
    // "no output for 0s" would be nonsense.
    expect(formatStallDuration(3_000)).toBe("3s");
  });
});

describe("resolveIdleMs", () => {
  const receivedAt = new Date(10_000);

  function idle(overrides: Partial<Parameters<typeof resolveIdleMs>[0]> = {}): number {
    return resolveIdleMs({
      activeTurnIdleMs: undefined,
      activeTurnIdleReceivedAt: undefined,
      lastStreamActivityAtMs: undefined,
      observationStartedAtMs: 0,
      nowMs: 20_000,
      ...overrides,
    });
  }

  it("falls back to the observation window when no source has a value", () => {
    // Silence the client watched first-hand. It starts at zero and grows, so a genuine stall
    // still surfaces from this candidate alone — late rather than wrong.
    expect(idle({ observationStartedAtMs: 8_000 })).toBe(12_000);
  });

  it("does not cap a usable daemon duration with the observation window", () => {
    // The window is zero-length at mount. Were it a cap rather than a substitute, opening an
    // agent that had genuinely been silent for ten minutes would show nothing for two more.
    expect(
      idle({
        activeTurnIdleMs: 600_000,
        activeTurnIdleReceivedAt: new Date(20_000),
        observationStartedAtMs: 20_000,
        nowMs: 20_000,
      }),
    ).toBe(600_000);
  });

  it("adds the client's own elapsed-since-receipt to the daemon duration", () => {
    // 5s measured on the daemon's clock, plus 10s measured on the client's. The two clocks
    // are never compared, only their independent deltas summed.
    expect(idle({ activeTurnIdleMs: 5_000, activeTurnIdleReceivedAt: receivedAt })).toBe(15_000);
  });

  it("ignores the daemon duration when its receipt instant is missing", () => {
    expect(idle({ activeTurnIdleMs: 5_000, activeTurnIdleReceivedAt: undefined })).toBe(20_000);
  });

  it("derives an idle duration from client-observed stream activity alone", () => {
    expect(idle({ lastStreamActivityAtMs: 12_000 })).toBe(8_000);
  });

  it("takes the freshest candidate, so a stale broadcast cannot invent a stall", () => {
    expect(
      idle({
        activeTurnIdleMs: 300_000,
        activeTurnIdleReceivedAt: receivedAt,
        lastStreamActivityAtMs: 19_000,
      }),
    ).toBe(1_000);
  });

  it("never returns a negative duration", () => {
    expect(
      idle({
        activeTurnIdleMs: 0,
        activeTurnIdleReceivedAt: new Date(30_000),
        lastStreamActivityAtMs: 30_000,
        observationStartedAtMs: 30_000,
      }),
    ).toBe(0);
  });

  describe("snapshots older than the observation window", () => {
    it("drops a daemon duration measured before the client started watching", () => {
      // Switching to an agent whose record is ten minutes old, mid-tool-call. `activeTurnIdleMs`
      // only refreshes on `emitState` and timeline events do not emit, so extrapolating it
      // across the unwatched gap would report ten minutes of silence for an agent that never
      // stopped working. Only the two seconds actually observed are claimed.
      expect(
        idle({
          activeTurnIdleMs: 600_000,
          activeTurnIdleReceivedAt: new Date(0),
          observationStartedAtMs: 618_000,
          nowMs: 620_000,
        }),
      ).toBe(2_000);
    });

    it("still trusts a snapshot that arrived just before the footer mounted", () => {
      // A cold open fetches the directory and then renders, so the record predates observation
      // by a render tick. That is scheduling, not a blind spot — without the grace window a
      // second client opening a genuinely stalled agent would show nothing for two minutes.
      expect(
        idle({
          activeTurnIdleMs: 600_000,
          activeTurnIdleReceivedAt: new Date(19_500),
          observationStartedAtMs: 20_000,
          nowMs: 20_000,
        }),
      ).toBe(600_500);
    });

    it("trusts a snapshot that arrived while the client was already watching", () => {
      // Nothing is inferred across an unwatched gap here: the client was subscribed the whole
      // time, so it would have seen any stream event that arrived after the snapshot.
      expect(
        idle({
          activeTurnIdleMs: 60_000,
          activeTurnIdleReceivedAt: new Date(10_000),
          observationStartedAtMs: 5_000,
          nowMs: 20_000,
        }),
      ).toBe(70_000);
    });
  });
});
