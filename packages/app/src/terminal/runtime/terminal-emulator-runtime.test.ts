import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

type StubTerminal = {
  write: (text: string, callback?: () => void) => void;
  reset: () => void;
  focus: () => void;
};

function createRuntimeWithTerminal(): {
  runtime: TerminalEmulatorRuntime;
  terminal: StubTerminal & {
    resetCalls: number;
  };
  writeCallbacks: Array<() => void>;
  writeTexts: string[];
} {
  const runtime = new TerminalEmulatorRuntime();
  const writeCallbacks: Array<() => void> = [];
  const writeTexts: string[] = [];
  let resetCalls = 0;

  const terminal: StubTerminal & { resetCalls: number } = {
    write: (text: string, callback?: () => void) => {
      writeTexts.push(text);
      if (callback) {
        writeCallbacks.push(callback);
      }
    },
    reset: () => {
      resetCalls += 1;
      terminal.resetCalls = resetCalls;
    },
    focus: () => {},
    resetCalls,
  };

  (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;

  return {
    runtime,
    terminal,
    writeCallbacks,
    writeTexts,
  };
}

describe("terminal-emulator-runtime", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: { __paseoTerminal?: unknown } }).window = {
      __paseoTerminal: undefined,
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.useRealTimers();
  });

  it("processes write and clear operations in strict order", () => {
    const { runtime, terminal, writeCallbacks, writeTexts } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      text: "first",
      onCommitted: () => {
        committed.push("first");
      },
    });
    runtime.clear({
      onCommitted: () => {
        committed.push("clear");
      },
    });
    runtime.write({
      text: "second",
      onCommitted: () => {
        committed.push("second");
      },
    });

    expect(writeTexts).toEqual(["first"]);
    expect(terminal.resetCalls).toBe(0);
    expect(committed).toEqual([]);

    writeCallbacks[0]?.();

    expect(committed).toEqual(["first", "clear"]);
    expect(terminal.resetCalls).toBe(1);
    expect(writeTexts).toEqual(["first", "second"]);

    writeCallbacks[1]?.();
    expect(committed).toEqual(["first", "clear", "second"]);
  });

  it("falls back to timeout commit when xterm write callback does not fire", () => {
    vi.useFakeTimers();
    const { runtime } = createRuntimeWithTerminal();
    const onCommitted = vi.fn();

    runtime.write({
      text: "stuck",
      onCommitted,
    });

    expect(onCommitted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("ignores stale duplicate write callbacks from a previous operation", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      text: "first",
      onCommitted: () => {
        committed.push("first");
      },
    });
    runtime.write({
      text: "second",
      onCommitted: () => {
        committed.push("second");
      },
    });

    writeCallbacks[0]?.();
    expect(committed).toEqual(["first"]);

    writeCallbacks[0]?.();
    expect(committed).toEqual(["first"]);

    writeCallbacks[1]?.();
    expect(committed).toEqual(["first", "second"]);
  });

  it("commits pending output operations during unmount to avoid deadlock", () => {
    const { runtime } = createRuntimeWithTerminal();
    const onCommittedA = vi.fn();
    const onCommittedB = vi.fn();

    runtime.write({
      text: "a",
      onCommitted: onCommittedA,
    });
    runtime.write({
      text: "b",
      onCommitted: onCommittedB,
    });

    runtime.unmount();

    expect(onCommittedA).toHaveBeenCalledTimes(1);
    expect(onCommittedB).toHaveBeenCalledTimes(1);
  });

  it("forces a refit when resize is requested", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as { fitAndEmitResize: (force: boolean) => void }).fitAndEmitResize =
      fitAndEmitResize;

    runtime.resize();
    runtime.resize({ force: true });

    expect(fitAndEmitResize).toHaveBeenNthCalledWith(1, false);
    expect(fitAndEmitResize).toHaveBeenNthCalledWith(2, true);
  });
});
