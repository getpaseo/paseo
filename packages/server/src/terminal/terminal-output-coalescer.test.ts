import { describe, expect, test } from "vitest";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";

function createHarness() {
  let nextTimer = 1;
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
  const flushes: Array<{ payload: string; chars: number; bytes: number }> = [];
  const coalescer = new TerminalOutputCoalescer({
    timers: {
      setTimeout: ((callback: () => void, delayMs?: number) => {
        const id = nextTimer;
        nextTimer += 1;
        scheduled.set(id, { callback, delayMs: delayMs ?? 0 });
        return id;
      }) as typeof setTimeout,
      clearTimeout: ((id: number) => {
        scheduled.delete(id);
      }) as typeof clearTimeout,
    },
    onFlush: ({ payload, chars, bytes }) => {
      flushes.push({ payload: payload.toString("utf8"), chars, bytes });
    },
  });

  return {
    coalescer,
    flushes,
    scheduled,
    runScheduled() {
      const callbacks = Array.from(scheduled.values());
      scheduled.clear();
      for (const { callback } of callbacks) {
        callback();
      }
    },
  };
}

describe("TerminalOutputCoalescer", () => {
  test("coalesces output into one 5ms flush window", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    coalescer.handle("a");
    coalescer.handle("b");
    coalescer.handle("é");

    expect(scheduled.size).toBe(1);
    expect(Array.from(scheduled.values())).toEqual([
      { callback: expect.any(Function), delayMs: 5 },
    ]);
    expect(flushes).toEqual([]);

    runScheduled();

    expect(flushes).toEqual([{ payload: "abé", chars: 3, bytes: 4 }]);
  });

  test("manual flush drains pending output and cancels the scheduled flush", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    coalescer.handle("hello");
    coalescer.flush();
    runScheduled();

    expect(scheduled.size).toBe(0);
    expect(flushes).toEqual([{ payload: "hello", chars: 5, bytes: 5 }]);
  });

  test("dispose drops pending output", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    coalescer.handle("pending");
    coalescer.dispose();
    runScheduled();

    expect(scheduled.size).toBe(0);
    expect(flushes).toEqual([]);
  });
});
