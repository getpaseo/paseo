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
    constructor(callback: WebLinksCallback) {
      webLinksCallbacks.values.push(callback);
    }
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
  values: [] as Array<{ linkHandler?: LinkHandler }>,
}));

const webLinksCallbacks = vi.hoisted(() => ({
  values: [] as WebLinksCallback[],
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    rows = 24;
    cols = 80;
    unicode = { activeVersion: "" };
    parser = {
      registerCsiHandler: () => undefined,
      registerOscHandler: () => undefined,
    };
    constructor(options: { linkHandler?: LinkHandler }) {
      terminalConstructorOptions.values.push(options);
    }
    loadAddon(): void {}
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    open(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler(): void {}
    dispose(): void {}
    refresh(): void {}
  },
}));

import {
  createTerminalResizeEvent,
  encodeTerminalOutput,
  TerminalEmulatorRuntime,
} from "./terminal-emulator-runtime";

interface StubTerminal {
  write: (data: string | Uint8Array, callback?: () => void) => void;
  reset: () => void;
  resize?: (cols: number, rows: number) => void;
  focus: () => void;
  refresh?: (start: number, end: number) => void;
  options?: { theme?: unknown; scrollback?: number; fontFamily?: string; fontSize?: number };
  rows?: number;
  cols?: number;
}

interface LinkHandler {
  activate: (event: { preventDefault: () => void }, uri: string) => void;
}

interface WebLinksCallback {
  (event: { preventDefault: () => void }, uri: string): void;
}

interface TestWindow {
  __paseoTerminal?: unknown;
  addEventListener: (...args: unknown[]) => void;
  clearTimeout: typeof clearTimeout;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  removeEventListener: (...args: unknown[]) => void;
  setTimeout: typeof setTimeout;
}

interface TestElement {
  innerHTML: string;
  offsetHeight: number;
  offsetWidth: number;
  parentElement: TestElement | null;
  style: {
    [property: string]: string | ((property: string, value: string) => void);
    getPropertyValue: (property: string) => string;
    setProperty: (property: string, value: string) => void;
  };
  addEventListener: () => void;
  removeEventListener: () => void;
  querySelector: () => null;
  querySelectorAll: () => TestElement[];
}

function createTestElement(): TestElement {
  const style = {
    getPropertyValue: () => "",
    setProperty: () => {},
  } as TestElement["style"];
  return {
    innerHTML: "",
    offsetHeight: 0,
    offsetWidth: 0,
    parentElement: null,
    style,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function mountInput(): {
  root: TestElement;
  host: TestElement;
} {
  return {
    root: createTestElement(),
    host: createTestElement(),
  };
}

function mountRuntime(runtime: TerminalEmulatorRuntime): void {
  const { root, host } = mountInput();
  runtime.mount({
    root: root as unknown as HTMLDivElement,
    host: host as unknown as HTMLDivElement,
    initialSnapshot: null,
    scrollback: 10_000,
    theme: { background: "#0b0b0b", foreground: "#e6e6e6", cursor: "#e6e6e6" },
  });
}

interface RuntimeFitProbe {
  fitAndEmitResize: (input?: {
    forceRefresh?: boolean;
    shouldClaim?: boolean;
    forceClaim?: boolean;
  }) => void;
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
  const terminalState = attachStubTerminal(runtime);

  return {
    runtime,
    ...terminalState,
  };
}

function attachStubTerminal(runtime: TerminalEmulatorRuntime): {
  terminal: StubTerminal & {
    resetCalls: number;
  };
  writeCallbacks: Array<() => void>;
  writeTexts: string[];
} {
  const writeCallbacks: Array<() => void> = [];
  const writeTexts: string[] = [];
  let resetCalls = 0;

  const terminal: StubTerminal & { resetCalls: number } = {
    write: (data: string | Uint8Array, callback?: () => void) => {
      const text = decodeTerminalOutput(data);
      // The runtime submits a zero-length sentinel write to gate barrier ops behind the
      // drained write run. Keep its callback (the gate resolves through it) but exclude the
      // empty payload from writeTexts so assertions read like real terminal output.
      if (text.length > 0) {
        writeTexts.push(text);
      }
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
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  const originalRequestAnimationFrame = (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame;
  const originalCancelAnimationFrame = (globalThis as { cancelAnimationFrame?: unknown })
    .cancelAnimationFrame;

  beforeEach(() => {
    (globalThis as { window?: TestWindow }).window = {
      addEventListener: () => {},
      clearTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
      removeEventListener: () => {},
      setTimeout,
      __paseoTerminal: undefined,
    };
    const documentElement = createTestElement();
    const body = createTestElement();
    (globalThis as { document?: unknown }).document = {
      addEventListener: () => {},
      body,
      documentElement,
      fonts: {
        ready: Promise.resolve(),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      removeEventListener: () => {},
      visibilityState: "visible",
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class ResizeObserver {
      disconnect(): void {}
      observe(): void {}
    };
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
      callback: FrameRequestCallback,
    ) => setTimeout(() => callback(Date.now()), 0);
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (handle: number) => {
      clearTimeout(handle);
    };
    terminalConstructorOptions.values = [];
    webLinksCallbacks.values = [];
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    (globalThis as { document?: unknown }).document = originalDocument;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
      originalRequestAnimationFrame;
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame =
      originalCancelAnimationFrame;
    vi.useRealTimers();
  });

  it("routes OSC 8 hyperlink activation through the runtime callback", () => {
    const onOpenUrl = vi.fn();
    const runtime = new TerminalEmulatorRuntime();

    runtime.setCallbacks({ callbacks: { onOpenUrl } });
    mountRuntime(runtime);

    const linkHandler = terminalConstructorOptions.values[0]?.linkHandler;
    if (!linkHandler) {
      throw new Error("Expected mount to configure an xterm link handler");
    }
    const event = { preventDefault: vi.fn() };

    linkHandler.activate(event, "https://example.com/pull/42");

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/pull/42");
    runtime.unmount();
  });

  it("honors callbacks set after mounting when an OSC 8 link is activated", () => {
    const runtime = new TerminalEmulatorRuntime();

    mountRuntime(runtime);
    const linkHandler = terminalConstructorOptions.values[0]?.linkHandler;
    if (!linkHandler) {
      throw new Error("Expected mount to configure an xterm link handler");
    }
    const onOpenUrl = vi.fn();
    runtime.setCallbacks({ callbacks: { onOpenUrl } });

    linkHandler.activate({ preventDefault: vi.fn() }, "https://example.com/late");

    expect(onOpenUrl).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/late");
    runtime.unmount();
  });

  it("routes plain-text URL activation through the runtime callback", () => {
    const onOpenUrl = vi.fn();
    const runtime = new TerminalEmulatorRuntime();

    runtime.setCallbacks({ callbacks: { onOpenUrl } });
    mountRuntime(runtime);
    const callback = webLinksCallbacks.values[0];
    if (!callback) {
      throw new Error("Expected mount to configure a WebLinksAddon callback");
    }
    const event = { preventDefault: vi.fn() };

    callback(event, "https://example.com/plain");

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/plain");
    runtime.unmount();
  });

  it("drains contiguous plain writes without waiting for each commit, gating a clear behind them", () => {
    const { runtime, terminal, writeCallbacks, writeTexts } = createRuntimeWithTerminal();
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
    runtime.clear({
      onCommitted: () => {
        committed.push("clear");
      },
    });
    runtime.write({
      data: terminalOutput("third"),
      onCommitted: () => {
        committed.push("third");
      },
    });

    // Both plain writes are submitted back-to-back; neither waited on the other's callback.
    // The clear and the write after it stay queued behind the barrier gate (sentinel write).
    expect(writeTexts).toEqual(["first", "second"]);
    expect(terminal.resetCalls).toBe(0);
    expect(committed).toEqual([]);

    // writeCallbacks: [0]=first, [1]=second, [2]=barrier-gate sentinel.
    writeCallbacks[0]?.();
    writeCallbacks[1]?.();
    expect(committed).toEqual(["first", "second"]);
    expect(terminal.resetCalls).toBe(0);

    // Resolving the sentinel releases the clear, which resets and then drains "third".
    writeCallbacks[2]?.();
    expect(committed).toEqual(["first", "second", "clear"]);
    expect(terminal.resetCalls).toBe(1);
    expect(writeTexts).toEqual(["first", "second", "third"]);

    // "third" still commits through its own write callback.
    writeCallbacks[3]?.();
    expect(committed).toEqual(["first", "second", "clear", "third"]);
  });

  it("falls back to timeout commit for a barrier op when the gate sentinel never fires", () => {
    vi.useFakeTimers();
    const { runtime, terminal } = createRuntimeWithTerminal();
    const onCommitted = vi.fn();

    // restoreOutput is a barrier; if xterm never commits the gate sentinel, the barrier still
    // applies (and commits) after the 5s safety timeout instead of stalling forever.
    runtime.restoreOutput({
      data: terminalOutput("stuck"),
      onCommitted,
    });

    expect(onCommitted).not.toHaveBeenCalled();
    expect(terminal.resetCalls).toBe(0);
    vi.advanceTimersByTime(5_000);
    // The barrier now runs (write submitted) but its own commit still waits on xterm; advance
    // again to fire the barrier's own write timeout.
    vi.advanceTimersByTime(5_000);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("reports input mode changes from terminal output and resets them on snapshots", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const inputModeChanges: Array<{
      kittyKeyboardFlags: number;
      win32InputMode: boolean;
      bracketedPaste: boolean;
    }> = [];
    runtime.setCallbacks({
      callbacks: {
        onInputModeChange: (state) => {
          inputModeChanges.push({
            kittyKeyboardFlags: state.kittyKeyboardFlags,
            win32InputMode: state.win32InputMode,
            bracketedPaste: Boolean(state.bracketedPaste),
          });
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
    // The plain write reports kitty flags synchronously during drain; the snapshot resets
    // them only after its barrier gate (the sentinel write callback) resolves.
    expect(inputModeChanges).toEqual([
      { kittyKeyboardFlags: 7, win32InputMode: false, bracketedPaste: false },
    ]);

    // The plain write carries no onCommitted, so it registers no callback; writeCallbacks[0]
    // is the barrier gate sentinel.
    writeCallbacks[0]?.();

    expect(inputModeChanges).toEqual([
      { kittyKeyboardFlags: 7, win32InputMode: false, bracketedPaste: false },
      { kittyKeyboardFlags: 0, win32InputMode: false, bracketedPaste: false },
    ]);
  });

  it("exposes the tracked input mode state", () => {
    const { runtime } = createRuntimeWithTerminal();

    runtime.write({ data: terminalOutput("\x1b[?2004h") });

    expect(runtime.getInputModeState()).toMatchObject({
      bracketedPaste: true,
    });
  });

  it("commits each drained plain write through its own xterm callback", () => {
    const { runtime, writeTexts, writeCallbacks } = createRuntimeWithTerminal();
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

    // Both submitted without waiting; each commits independently when its callback fires.
    expect(writeTexts).toEqual(["first", "second"]);
    expect(committed).toEqual([]);

    writeCallbacks[1]?.();
    expect(committed).toEqual(["second"]);

    writeCallbacks[0]?.();
    expect(committed).toEqual(["second", "first"]);
  });

  it("applies a snapshot after the writes ahead of it, never interleaving the reset", () => {
    const { runtime, terminal, writeTexts, writeCallbacks } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      data: terminalOutput("before-a"),
      onCommitted: () => {
        committed.push("before-a");
      },
    });
    runtime.write({
      data: terminalOutput("before-b"),
      onCommitted: () => {
        committed.push("before-b");
      },
    });
    runtime.restoreOutput({
      data: terminalOutput("snap"),
      onCommitted: () => {
        committed.push("snap");
      },
    });

    // Plain writes are submitted up front; the snapshot's reset+write has not run yet.
    expect(writeTexts).toEqual(["before-a", "before-b"]);

    // writeCallbacks: [0]=before-a, [1]=before-b, [2]=barrier gate sentinel.
    // The snapshot is gated behind the prior writes; resolving the gate runs it after them.
    writeCallbacks[2]?.();
    expect(writeTexts).toEqual(["before-a", "before-b", "csnap"]);

    // Snapshot commit fires only after its own write callback, strictly after the writes.
    writeCallbacks[3]?.();
    expect(committed).toEqual(["snap"]);
    expect(terminal.resetCalls).toBe(0);
  });

  it("applies a barrier immediately when no writes precede it, suppressing input at once", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const readSuppressInput = () =>
      (runtime as unknown as { suppressInput: boolean }).suppressInput;

    expect(readSuppressInput()).toBe(false);

    // No plain writes precede this barrier (mount), so there is nothing to gate: it starts
    // at once with no sentinel, flipping suppressInput synchronously.
    runtime.restoreOutput({ data: terminalOutput("snapshot") });
    expect(readSuppressInput()).toBe(true);

    // writeCallbacks[0] is the barrier's own snapshot write; committing it restores input.
    writeCallbacks[0]?.();
    expect(readSuppressInput()).toBe(false);
  });

  it("gates a barrier behind a preceding plain write before suppressing input", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const readSuppressInput = () =>
      (runtime as unknown as { suppressInput: boolean }).suppressInput;

    // A plain write is now ungated, so the following barrier must wait on the sentinel.
    runtime.write({ data: terminalOutput("output") });
    runtime.restoreOutput({ data: terminalOutput("snapshot") });

    // The plain write carries no onCommitted so it registers no callback; writeCallbacks[0]
    // is the sentinel gate. suppressInput only flips once the gate resolves the barrier.
    expect(readSuppressInput()).toBe(false);
    writeCallbacks[0]?.();
    expect(readSuppressInput()).toBe(true);

    // writeCallbacks[1] is the barrier's own snapshot write; committing it restores input.
    writeCallbacks[1]?.();
    expect(readSuppressInput()).toBe(false);
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

  it("clears ungated writes on unmount so remount barriers apply immediately", () => {
    const { runtime } = createRuntimeWithTerminal();

    runtime.write({ data: terminalOutput("before unmount") });
    runtime.unmount();

    const remounted = attachStubTerminal(runtime);
    runtime.restoreOutput({ data: terminalOutput("restored screen") });

    expect(remounted.writeTexts).toEqual(["\u001bcrestored screen"]);
    expect(remounted.writeCallbacks).toHaveLength(1);
  });

  it("replays snapshots through a single write without first painting a reset terminal", () => {
    const { runtime, terminal, writeTexts, writeCallbacks } = createRuntimeWithTerminal();

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

    // The snapshot is a barrier; its write applies after the gate sentinel (writeCallbacks[0]).
    writeCallbacks[0]?.();

    expect(terminal.resetCalls).toBe(0);
    expect(writeTexts).toHaveLength(1);
    expect(writeTexts[0]?.startsWith("\u001bc")).toBe(true);
    expect(writeTexts[0]).toContain("hi");
  });

  it("restores server-rendered ANSI snapshots through the snapshot write path", () => {
    const { runtime, terminal, writeTexts, writeCallbacks } = createRuntimeWithTerminal();

    runtime.restoreOutput({ data: terminalOutput("restored screen") });

    // restoreOutput is a barrier (suppressInput); it applies after the gate sentinel.
    writeCallbacks[0]?.();

    expect(terminal.resetCalls).toBe(0);
    expect(writeTexts).toEqual(["\u001bcrestored screen"]);
  });

  it("forces a refit when resize is requested", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;

    runtime.resize();
    runtime.resize({ forceRefresh: true, shouldClaim: false });

    expect(fitAndEmitResize).toHaveBeenNthCalledWith(1, undefined);
    expect(fitAndEmitResize).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      shouldClaim: false,
    });
  });

  it("marks explicit resize claims as forced so another client can reclaim the same size", () => {
    expect(
      createTerminalResizeEvent({
        rows: 34,
        cols: 181,
        shouldClaim: true,
        forceClaim: true,
      }),
    ).toEqual({
      rows: 34,
      cols: 181,
      shouldClaim: true,
      forceClaim: true,
    });
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

  it("updates terminal font without remounting", () => {
    const runtime = new TerminalEmulatorRuntime();
    const refresh = vi.fn();
    const fitAndEmitResize = vi.fn();
    const terminal: StubTerminal = {
      write: () => {},
      reset: () => {},
      focus: () => {},
      refresh,
      options: { fontFamily: "before", fontSize: 13 },
      rows: 12,
      cols: 40,
    };
    (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;
    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;

    runtime.setFont({ fontFamily: "  Menlo  ", fontSize: 18 });

    expect(terminal.options?.fontFamily).toBe("Menlo");
    expect(terminal.options?.fontSize).toBe(18);
    expect(fitAndEmitResize).toHaveBeenCalledWith({
      forceRefresh: true,
      shouldClaim: false,
    });
    expect(refresh).toHaveBeenCalledWith(0, 11);
  });

  it("passively refits when the page becomes visible again", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;
    (globalThis as { document?: { visibilityState?: string } }).document = {
      visibilityState: "visible",
    };

    (
      runtime as unknown as {
        handleVisibilityRestore: () => void;
      }
    ).handleVisibilityRestore();

    expect(fitAndEmitResize).toHaveBeenCalledWith({
      forceRefresh: true,
      shouldClaim: false,
    });
  });

  it("does not refit while the page is still hidden", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;
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
