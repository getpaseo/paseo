import { describe, expect, it } from "vitest";
import { shouldPublishSettledKeyboardShift } from "@/keyboard/shift/internal/policy";
import {
  TERMINAL_KEYBOARD_REFIT_DELAYS_MS,
  createTerminalKeyboardRefitScheduler,
} from "./terminal-pane-keyboard-refit";

interface FakeTimer {
  id: number;
  at: number;
  callback: () => void;
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  let timers: FakeTimer[] = [];
  return {
    setTimeout(callback: () => void, delayMs: number): number {
      const id = nextId++;
      timers.push({ id, at: now + delayMs, callback });
      return id;
    },
    clearTimeout(id: number): void {
      timers = timers.filter((timer) => timer.id !== id);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        now = due.at;
        timers = timers.filter((timer) => timer.id !== due.id);
        due.callback();
      }
      now = target;
    },
    get pendingCount() {
      return timers.length;
    },
  };
}

function createRecordingScheduler() {
  const clock = createFakeClock();
  const calls: string[] = [];
  const scheduler = createTerminalKeyboardRefitScheduler({
    requestReflow: () => calls.push("reflow"),
    claimSize: () => calls.push("claim"),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, calls, scheduler };
}

// A 296px keyboard sliding open over ~250ms at 60fps: the rounded shift changes on every frame.
function keyboardOpenAnimationFrames(): Array<{ moving: boolean; shift: number }> {
  const frames = Array.from({ length: 15 }, (_, index) => ({
    moving: true,
    shift: Math.round((296 * (index + 1)) / 15),
  }));
  return [...frames, { moving: false, shift: 296 }];
}

describe("createTerminalKeyboardRefitScheduler", () => {
  it("refits immediately, then on each delay, and claims size once at the end", () => {
    const { clock, calls, scheduler } = createRecordingScheduler();

    scheduler.pulse();
    expect(calls).toEqual(["reflow"]);

    clock.advance(TERMINAL_KEYBOARD_REFIT_DELAYS_MS.at(-1) ?? 0);
    expect(calls).toEqual(["reflow", "reflow", "reflow", "reflow", "reflow", "claim"]);
    expect(clock.pendingCount).toBe(0);
  });

  it("restarts the pulse when the keyboard settles again before the previous pulse finishes", () => {
    const { clock, calls, scheduler } = createRecordingScheduler();

    scheduler.pulse();
    clock.advance(60);
    scheduler.pulse();
    clock.advance(1000);

    const claims = calls.filter((call) => call === "claim");
    expect(claims).toHaveLength(1);
    // first pulse: immediate + 0ms + 48ms before being cancelled; second pulse: full sequence.
    expect(calls.filter((call) => call === "reflow")).toHaveLength(3 + 5);
  });

  it("cancel drops every pending refit", () => {
    const { clock, calls, scheduler } = createRecordingScheduler();

    scheduler.pulse();
    scheduler.cancel();
    clock.advance(1000);

    expect(calls).toEqual(["reflow"]);
    expect(clock.pendingCount).toBe(0);
  });
});

describe("keyboard animation → terminal refit", () => {
  it("one keyboard open animation produces one refit pulse, not one per frame", () => {
    const { clock, calls, scheduler } = createRecordingScheduler();
    const samples = keyboardOpenAnimationFrames();

    let previous: { moving: boolean; shift: number } | null = null;
    let publishedInset: number | null = null;
    let pulses = 0;
    for (const sample of samples) {
      if (shouldPublishSettledKeyboardShift({ current: sample, previous })) {
        publishedInset = sample.shift;
        pulses += 1;
        scheduler.pulse();
      }
      previous = sample;
      clock.advance(1000 / 60);
    }
    clock.advance(1000);

    const distinctRoundedFrames = new Set(samples.map((sample) => sample.shift)).size;
    expect(distinctRoundedFrames).toBe(15);
    expect(pulses).toBe(1);
    expect(publishedInset).toBe(296);
    expect(calls.filter((call) => call === "reflow")).toHaveLength(
      TERMINAL_KEYBOARD_REFIT_DELAYS_MS.length + 1,
    );
    expect(calls.filter((call) => call === "claim")).toHaveLength(1);
  });
});
