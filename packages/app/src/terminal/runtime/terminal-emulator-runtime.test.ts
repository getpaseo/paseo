import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class ClipboardAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class ImageAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-ligatures/lib/addon-ligatures.mjs", () => ({
  LigaturesAddon: class LigaturesAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class SearchAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class Unicode11Addon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class WebLinksAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));

const terminalConstructorOptions = vi.hoisted(() => ({
  values: [] as unknown[],
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    rows = 24;
    cols = 80;
    unicode = { activeVersion: "" };
    parser = {
      registerCsiHandler: () => undefined,
    };
    constructor(options: unknown) {
      terminalConstructorOptions.values.push(options);
    }
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler(): void {}
    dispose(): void {}
    refresh(): void {}
  },
}));

import { encodeTerminalOutput, TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

interface StubTerminal {
  write: (data: string | Uint8Array, callback?: () => void) => void;
  reset: () => void;
  resize?: (cols: number, rows: number) => void;
  focus: () => void;
  refresh?: (start: number, end: number) => void;
  options?: { theme?: unknown; scrollback?: number };
  rows?: number;
  cols?: number;
}

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
    write: (data: string | Uint8Array, callback?: () => void) => {
      writeTexts.push(decodeTerminalOutput(data));
      if (callback) {
        writeCallbacks.push(callback);
      }
    },
    reset: () => {
      resetCalls += 1;
      terminal.resetCalls = resetCalls;
    },
    resize: () => {},
    focus: () => {},
    refresh: () => {},
    options: { theme: undefined },
    rows: 0,
    cols: 0,
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

function terminalOutput(text: string): Uint8Array {
  return encodeTerminalOutput(text);
}

function decodeTerminalOutput(data: string | Uint8Array): string {
  if (typeof data === "string") {
    return data;
  }
  return new TextDecoder().decode(data);
}

describe("terminal-emulator-runtime", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: { __paseoTerminal?: unknown } }).window = {
      __paseoTerminal: undefined,
    };
    terminalConstructorOptions.values = [];
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.useRealTimers();
  });

  it("processes write and clear operations in strict order", () => {
    const { runtime, terminal, writeCallbacks, writeTexts } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      data: terminalOutput("first"),
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
      data: terminalOutput("second"),
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
      data: terminalOutput("stuck"),
      onCommitted,
    });

    expect(onCommitted).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("reports input mode changes from terminal output and resets them on snapshots", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const inputModeChanges: Array<{ kittyKeyboardFlags: number; win32InputMode: boolean }> = [];
    runtime.setCallbacks({
      callbacks: {
        onInputModeChange: (state) => {
          inputModeChanges.push(state);
        },
      },
    });

    runtime.write({ data: terminalOutput("\x1b[>7u") });
    runtime.renderSnapshot({
      state: {
        rows: 2,
        cols: 8,
        scrollback: [],
        grid: [[{ char: "$" }, { char: " " }]],
        cursor: {
          row: 0,
          col: 2,
        },
      },
    });
    writeCallbacks[0]?.();

    expect(inputModeChanges).toEqual([
      { kittyKeyboardFlags: 7, win32InputMode: false },
      { kittyKeyboardFlags: 0, win32InputMode: false },
    ]);
  });

  it("ignores stale duplicate write callbacks from a previous operation", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      data: terminalOutput("first"),
      onCommitted: () => {
        committed.push("first");
      },
    });
    runtime.write({
      data: terminalOutput("second"),
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
      data: terminalOutput("a"),
      onCommitted: onCommittedA,
    });
    runtime.write({
      data: terminalOutput("b"),
      onCommitted: onCommittedB,
    });

    runtime.unmount();

    expect(onCommittedA).toHaveBeenCalledTimes(1);
    expect(onCommittedB).toHaveBeenCalledTimes(1);
  });

  it("replays snapshots through a single write without first painting a reset terminal", () => {
    const { runtime, terminal, writeTexts } = createRuntimeWithTerminal();

    runtime.renderSnapshot({
      state: {
        rows: 2,
        cols: 8,
        scrollback: [],
        grid: [
          [{ char: "h" }, { char: "i" }],
          [{ char: "$" }, { char: " " }],
        ],
        cursor: {
          row: 1,
          col: 2,
        },
      },
    });

    expect(terminal.resetCalls).toBe(0);
    expect(writeTexts).toHaveLength(1);
    expect(writeTexts[0]?.startsWith("\u001bc")).toBe(true);
    expect(writeTexts[0]).toContain("hi");
  });

  it("restores server-rendered ANSI snapshots through the snapshot write path", () => {
    const { runtime, terminal, writeTexts } = createRuntimeWithTerminal();

    runtime.restoreOutput({ data: terminalOutput("restored screen") });

    expect(terminal.resetCalls).toBe(0);
    expect(writeTexts).toEqual(["\u001bcrestored screen"]);
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

  it("updates terminal theme without remounting", () => {
    const runtime = new TerminalEmulatorRuntime();
    const refresh = vi.fn();
    const terminal: StubTerminal = {
      write: () => {},
      reset: () => {},
      focus: () => {},
      refresh,
      options: { theme: { background: "before" } },
      rows: 12,
      cols: 40,
    };
    (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;

    runtime.setTheme({ theme: { background: "after" } as never });

    expect(terminal.options?.theme).toEqual({
      background: "after",
      overviewRulerBorder: "after",
    });
    expect(refresh).toHaveBeenCalledWith(0, 11);
  });

  it("updates terminal scrollback without remounting", () => {
    const runtime = new TerminalEmulatorRuntime();
    const refresh = vi.fn();
    const terminal: StubTerminal = {
      write: () => {},
      reset: () => {},
      focus: () => {},
      refresh,
      options: { scrollback: 10_000 },
      rows: 12,
      cols: 40,
    };
    (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;

    runtime.setScrollback({ lines: 42_000 });

    expect(terminal.options?.scrollback).toBe(42_000);
    expect(refresh).toHaveBeenCalledWith(0, 11);
  });

  it("forces a refit when the page becomes visible again", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as { fitAndEmitResize: (force: boolean) => void }).fitAndEmitResize =
      fitAndEmitResize;
    (globalThis as { document?: { visibilityState?: string } }).document = {
      visibilityState: "visible",
    };

    (
      runtime as unknown as {
        handleVisibilityRestore: () => void;
      }
    ).handleVisibilityRestore();

    expect(fitAndEmitResize).toHaveBeenCalledWith(true);
  });

  it("does not refit while the page is still hidden", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as { fitAndEmitResize: (force: boolean) => void }).fitAndEmitResize =
      fitAndEmitResize;
    (globalThis as { document?: { visibilityState?: string } }).document = {
      visibilityState: "hidden",
    };

    (
      runtime as unknown as {
        handleVisibilityRestore: () => void;
      }
    ).handleVisibilityRestore();

    expect(fitAndEmitResize).not.toHaveBeenCalled();
  });
});
