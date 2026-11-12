import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalResizeDebouncer } from "./terminal-resize-debouncer";

describe("terminal resize debouncer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits only the latest size after resize callbacks settle", () => {
    vi.useFakeTimers();
    const emitted: Array<{
      rows: number;
      cols: number;
      shouldClaim: boolean;
      forceClaim?: boolean;
    }> = [];
    const debouncer = createTerminalResizeDebouncer({
      delayMs: 100,
      emit: (resize) => emitted.push(resize),
    });

    debouncer.schedule({ rows: 40, cols: 100, shouldClaim: false });
    vi.advanceTimersByTime(50);
    debouncer.schedule({ rows: 35, cols: 100, shouldClaim: false });
    vi.advanceTimersByTime(99);

    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(emitted).toEqual([{ rows: 35, cols: 100, shouldClaim: false }]);
  });

  it("preserves a claim while taking the latest dimensions", () => {
    vi.useFakeTimers();
    const emitted: Array<{
      rows: number;
      cols: number;
      shouldClaim: boolean;
      forceClaim?: boolean;
    }> = [];
    const debouncer = createTerminalResizeDebouncer({
      delayMs: 100,
      emit: (resize) => emitted.push(resize),
    });

    debouncer.schedule({ rows: 40, cols: 100, shouldClaim: true, forceClaim: true });
    debouncer.schedule({ rows: 35, cols: 100, shouldClaim: false });
    vi.runAllTimers();

    expect(emitted).toEqual([{ rows: 35, cols: 100, shouldClaim: true, forceClaim: true }]);
  });

  it("cancels a pending resize", () => {
    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const debouncer = createTerminalResizeDebouncer({
      delayMs: 100,
      emit: (resize) => emitted.push(resize),
    });

    debouncer.schedule({ rows: 40, cols: 100, shouldClaim: false });
    debouncer.cancel();
    vi.runAllTimers();

    expect(emitted).toEqual([]);
  });

  it("holds resizes longer while a pinch runs and sends the last one when it ends", () => {
    vi.useFakeTimers();
    let pinching = true;
    const emitted: Array<{ rows: number; cols: number }> = [];
    const debouncer = createTerminalResizeDebouncer({
      delayMs: () => (pinching ? 150 : 100),
      emit: ({ rows, cols }) => emitted.push({ rows, cols }),
    });

    debouncer.schedule({ rows: 40, cols: 90, shouldClaim: false });
    vi.advanceTimersByTime(100);
    debouncer.schedule({ rows: 36, cols: 80, shouldClaim: false });
    vi.advanceTimersByTime(149);
    expect(emitted).toEqual([]);

    pinching = false;
    debouncer.flush();
    expect(emitted).toEqual([{ rows: 36, cols: 80 }]);
    vi.advanceTimersByTime(500);
    debouncer.flush();
    expect(emitted).toHaveLength(1);
  });

  it("sends a pinch's size once it has been stable for 150 ms", () => {
    vi.useFakeTimers();
    const emitted: Array<{ rows: number; cols: number }> = [];
    const debouncer = createTerminalResizeDebouncer({
      delayMs: () => 150,
      emit: ({ rows, cols }) => emitted.push({ rows, cols }),
    });
    debouncer.schedule({ rows: 30, cols: 70, shouldClaim: false });
    vi.advanceTimersByTime(150);
    expect(emitted).toEqual([{ rows: 30, cols: 70 }]);
  });
});
