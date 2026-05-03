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
    findNext(): boolean {
      return false;
    }
    findPrevious(): boolean {
      return false;
    }
    clearDecorations(): void {}
    onDidChangeResults(): { dispose: () => void } {
      return { dispose: () => {} };
    }
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

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    dispose(): void {}
  },
}));

import { TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

interface StubTerminal {
  write: (text: string, callback?: () => void) => void;
  reset: () => void;
  resize?: (cols: number, rows: number) => void;
  focus: () => void;
  refresh?: (start: number, end: number) => void;
  options?: { theme?: unknown };
  rows?: number;
  cols?: number;
}

interface StubSearchAddon {
  findNext: (term: string, options?: unknown) => boolean;
  findPrevious: (term: string, options?: unknown) => boolean;
  clearDecorations: () => void;
  onDidChangeResults: (listener: (event: { resultIndex: number; resultCount: number }) => void) => {
    dispose: () => void;
  };
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

function createRuntimeWithSearchAddon(input?: {
  findNextResult?: boolean;
  findPreviousResult?: boolean;
}): {
  runtime: TerminalEmulatorRuntime;
  searchAddon: StubSearchAddon;
  calls: {
    findNext: Array<{ term: string; options: unknown }>;
    findPrevious: Array<{ term: string; options: unknown }>;
    clearDecorations: number;
    subscribedListeners: Array<(event: { resultIndex: number; resultCount: number }) => void>;
    disposeSubscription: number;
  };
} {
  const runtime = new TerminalEmulatorRuntime();
  const calls = {
    findNext: [] as Array<{ term: string; options: unknown }>,
    findPrevious: [] as Array<{ term: string; options: unknown }>,
    clearDecorations: 0,
    subscribedListeners: [] as Array<(event: { resultIndex: number; resultCount: number }) => void>,
    disposeSubscription: 0,
  };
  const searchAddon: StubSearchAddon = {
    findNext: (term, options) => {
      calls.findNext.push({ term, options });
      return input?.findNextResult ?? true;
    },
    findPrevious: (term, options) => {
      calls.findPrevious.push({ term, options });
      return input?.findPreviousResult ?? true;
    },
    clearDecorations: () => {
      calls.clearDecorations += 1;
    },
    onDidChangeResults: (listener) => {
      calls.subscribedListeners.push(listener);
      return {
        dispose: () => {
          calls.disposeSubscription += 1;
        },
      };
    },
  };

  (runtime as unknown as { searchAddon: StubSearchAddon }).searchAddon = searchAddon;

  return { runtime, searchAddon, calls };
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

  it("delegates find navigation and clearing to the stored xterm search addon", () => {
    const { runtime, calls } = createRuntimeWithSearchAddon({
      findNextResult: true,
      findPreviousResult: false,
    });

    expect(runtime.findNext({ query: "needle" })).toBe(true);
    expect(runtime.findPrevious({ query: "needle" })).toBe(false);
    runtime.clearFindDecorations();

    expect(calls.findNext).toEqual([
      {
        term: "needle",
        options: {
          caseSensitive: false,
          decorations: {
            matchBackground: "#facc15",
            matchOverviewRuler: "#facc15",
            activeMatchBackground: "#38bdf8",
            activeMatchColorOverviewRuler: "#38bdf8",
          },
        },
      },
    ]);
    expect(calls.findPrevious).toEqual([
      {
        term: "needle",
        options: {
          caseSensitive: false,
          decorations: {
            matchBackground: "#facc15",
            matchOverviewRuler: "#facc15",
            activeMatchBackground: "#38bdf8",
            activeMatchColorOverviewRuler: "#38bdf8",
          },
        },
      },
    ]);
    expect(calls.clearDecorations).toBe(1);
  });

  it("forwards xterm search result changes and disposes the subscription", () => {
    const { runtime, calls } = createRuntimeWithSearchAddon();
    const events: Array<{ resultIndex: number; resultCount: number }> = [];

    const unsubscribe = runtime.onFindResultsChanged((event) => {
      events.push(event);
    });
    calls.subscribedListeners[0]?.({ resultIndex: 2, resultCount: 5 });
    unsubscribe();

    expect(events).toEqual([{ resultIndex: 2, resultCount: 5 }]);
    expect(calls.disposeSubscription).toBe(1);
  });

  it("keeps find methods inert before the search addon is mounted", () => {
    const runtime = new TerminalEmulatorRuntime();
    const listener = vi.fn();

    expect(runtime.findNext({ query: "needle" })).toBe(false);
    expect(runtime.findPrevious({ query: "needle" })).toBe(false);
    runtime.clearFindDecorations();
    runtime.onFindResultsChanged(listener)();

    expect(listener).not.toHaveBeenCalled();
  });
});
