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
});
