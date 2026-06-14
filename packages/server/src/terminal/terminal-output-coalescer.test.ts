import { describe, expect, test } from "vitest";
import { TerminalOutputCoalescer } from "./terminal-output-coalescer.js";

function createHarness() {
  let nextTimer = 1;
  let now = 1000;
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
    now: () => now,
    onFlush: ({ payload, chars, bytes }) => {
      flushes.push({ payload: payload.toString("utf8"), chars, bytes });
    },
  });

  return {
    coalescer,
    flushes,
    scheduled,
    advance(ms: number) {
      now += ms;
    },
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
  test("flushes the first chunk immediately on the leading edge", () => {
    const { coalescer, flushes, scheduled } = createHarness();

    coalescer.handle("a");

    // No timer scheduled: the leading-edge flush happened synchronously.
    expect(scheduled.size).toBe(0);
    expect(flushes).toEqual([{ payload: "a", chars: 1, bytes: 1 }]);
  });

  test("coalesces a burst that follows the leading-edge flush into one trailing flush", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    // First chunk flushes immediately (leading edge).
    coalescer.handle("a");
    // Subsequent chunks within the window accumulate behind a trailing timer.
    coalescer.handle("b");
    coalescer.handle("é");

    expect(scheduled.size).toBe(1);
    expect(Array.from(scheduled.values())).toEqual([
      { callback: expect.any(Function), delayMs: 5 },
    ]);
    expect(flushes).toEqual([{ payload: "a", chars: 1, bytes: 1 }]);

    runScheduled();

    expect(flushes).toEqual([
      { payload: "a", chars: 1, bytes: 1 },
      { payload: "bé", chars: 2, bytes: 3 },
    ]);
  });

  test("flushes immediately again once the window has elapsed", () => {
    const { coalescer, flushes, advance, scheduled } = createHarness();

    coalescer.handle("a");
    expect(flushes).toEqual([{ payload: "a", chars: 1, bytes: 1 }]);

    advance(5);
    coalescer.handle("b");

    expect(scheduled.size).toBe(0);
    expect(flushes).toEqual([
      { payload: "a", chars: 1, bytes: 1 },
      { payload: "b", chars: 1, bytes: 1 },
    ]);
  });

  test("manual flush drains pending output and cancels the scheduled flush", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    // Leading-edge flush, then accumulate a burst behind the trailing timer.
    coalescer.handle("hello");
    coalescer.handle(" world");
    coalescer.flush();
    runScheduled();

    expect(scheduled.size).toBe(0);
    expect(flushes).toEqual([
      { payload: "hello", chars: 5, bytes: 5 },
      { payload: " world", chars: 6, bytes: 6 },
    ]);
  });

  test("dispose drops pending output", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    // First chunk flushes on the leading edge; second one stays pending.
    coalescer.handle("done");
    coalescer.handle("pending");
    coalescer.dispose();
    runScheduled();

    expect(scheduled.size).toBe(0);
    expect(flushes).toEqual([{ payload: "done", chars: 4, bytes: 4 }]);
  });

  test("markFlushed keeps the next chunk on the trailing path", () => {
    const { coalescer, flushes, runScheduled, scheduled } = createHarness();

    // Simulate a frame emitted out-of-band (e.g. a snapshot) right before output.
    coalescer.markFlushed();
    coalescer.handle("post-snapshot");

    // No immediate flush: the chunk waits for the trailing timer.
    expect(scheduled.size).toBe(1);
    expect(flushes).toEqual([]);

    runScheduled();
    expect(flushes).toEqual([{ payload: "post-snapshot", chars: 13, bytes: 13 }]);
  });

  test("preserves ordering across leading and trailing flushes", () => {
    const { coalescer, flushes, runScheduled, advance } = createHarness();

    coalescer.handle("1");
    coalescer.handle("2");
    coalescer.handle("3");
    runScheduled();
    advance(5);
    coalescer.handle("4");

    expect(flushes.map((f) => f.payload)).toEqual(["1", "23", "4"]);
  });
});
