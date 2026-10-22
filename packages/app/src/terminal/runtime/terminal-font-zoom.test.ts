import { afterEach, describe, expect, it } from "vitest";
import {
  TERMINAL_FONT_SIZE_STORAGE_KEY,
  TerminalFontZoomRegistry,
  consumeInstalledTerminalFontZoom,
  installTerminalFontZoomBridge,
  nextTerminalFontSize,
  terminalFontZoomStepsFromWheel,
  terminalZoomDirectionFromKeyboardEvent,
  type TerminalFontSizeStorage,
} from "./terminal-font-zoom";

function helper() {
  return { classList: { contains: (token: string) => token === "xterm-helper-textarea" } };
}

function memoryStorage(
  initial?: string,
): TerminalFontSizeStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(TERMINAL_FONT_SIZE_STORAGE_KEY, initial);
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function terminal(fontSize: number, textarea: ReturnType<typeof helper> | null = helper()) {
  const fits: Array<{ forceRefresh: true; shouldClaim: true }> = [];
  return {
    textarea,
    options: { fontSize },
    fits,
    fit(request: { forceRefresh: true; shouldClaim: true }) {
      fits.push(request);
    },
  };
}

describe("terminal font zoom", () => {
  afterEach(() => {
    const host = globalThis as {
      paseoConsumeTerminalZoom?: unknown;
      __paseoTerminalZoomWheel?: unknown;
    };
    delete host.paseoConsumeTerminalZoom;
    delete host.__paseoTerminalZoomWheel;
  });

  it("steps one pixel and clamps", () => {
    expect(nextTerminalFontSize(12, 12, "in")).toBe(13);
    expect(nextTerminalFontSize(32, 12, "in")).toBe(32);
    expect(nextTerminalFontSize(8, 12, "out")).toBe(8);
    expect(nextTerminalFontSize(20, 12, "reset")).toBe(12);
  });

  it("reads the desktop zoom chords", () => {
    expect(
      terminalZoomDirectionFromKeyboardEvent({
        type: "keydown",
        key: "=",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("in");
    expect(
      terminalZoomDirectionFromKeyboardEvent({
        type: "keydown",
        key: "+",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe("in");
    expect(
      terminalZoomDirectionFromKeyboardEvent({
        type: "keydown",
        key: "c",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  it("changes only the focused terminal and keeps that size across a settings write", () => {
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>();
    const focused = terminal(12);
    const other = terminal(12);
    registry.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    registry.register({ terminal: other, fit: other.fit, baseFontSize: 12 });

    expect(registry.consume("in", focused.textarea)).toBe(true);
    expect(focused.options.fontSize).toBe(13);
    expect(focused.fits).toEqual([{ forceRefresh: true, shouldClaim: true }]);
    expect(other.options.fontSize).toBe(12);

    expect(registry.settingsFontSize(focused, 16)).toBeNull();
    expect(focused.options.fontSize).toBe(13);

    expect(registry.consume("reset", focused.textarea)).toBe(true);
    expect(focused.options.fontSize).toBe(12);
    expect(registry.settingsFontSize(focused, 16)).toBe(16);
  });

  it("leaves the window zoom path alone when focus is outside the terminal", () => {
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>();
    const focused = terminal(12);
    registry.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    expect(registry.consume("in", { classList: { contains: () => false } })).toBe(false);
    expect(focused.options.fontSize).toBe(12);
    expect(focused.fits).toEqual([]);
  });

  it("installs one page hook the desktop menu can call", () => {
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>();
    const focused = terminal(12);
    registry.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    installTerminalFontZoomBridge(registry);
    installTerminalFontZoomBridge(registry);
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { activeElement: unknown } }).document = {
      activeElement: focused.textarea,
    };

    expect(consumeInstalledTerminalFontZoom("in")).toBe(true);
    expect(focused.options.fontSize).toBe(13);
    expect(consumeInstalledTerminalFontZoom("nope")).toBe(false);
    (globalThis as { document?: unknown }).document = previousDocument;
  });

  it("turns one cmd wheel notch into one font step", () => {
    expect(
      terminalFontZoomStepsFromWheel(
        { ctrlKey: false, metaKey: true, altKey: false, deltaY: -100, deltaMode: 0 },
        0,
      ),
    ).toEqual({ steps: 1, remainder: 0 });
    expect(
      terminalFontZoomStepsFromWheel(
        { ctrlKey: false, metaKey: true, altKey: false, deltaY: 1, deltaMode: 1 },
        4,
      ),
    ).toEqual({ steps: -1, remainder: 4 });
    const partial = terminalFontZoomStepsFromWheel(
      { ctrlKey: false, metaKey: true, altKey: false, deltaY: -40, deltaMode: 0 },
      0,
    );
    expect(partial).toEqual({ steps: 0, remainder: -40 });
    expect(
      terminalFontZoomStepsFromWheel(
        { ctrlKey: false, metaKey: true, altKey: false, deltaY: -60, deltaMode: 0 },
        partial?.remainder ?? 0,
      ),
    ).toEqual({ steps: 1, remainder: 0 });
    expect(
      terminalFontZoomStepsFromWheel(
        { ctrlKey: true, metaKey: false, altKey: false, deltaY: -100 },
        0,
      ),
    ).toBeNull();
    expect(
      terminalFontZoomStepsFromWheel(
        { ctrlKey: true, metaKey: true, altKey: false, deltaY: -100 },
        0,
      ),
    ).toBeNull();
  });

  it("grows the terminal under the pointer on cmd+wheel and leaves other wheels alone", () => {
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>();
    const focused = terminal(12);
    registry.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    const listeners: Array<(event: Event) => void> = [];
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { addEventListener: typeof document.addEventListener } }).document =
      {
        addEventListener(type, listener) {
          if (type === "wheel" && typeof listener === "function") listeners.push(listener);
        },
      } as Document;
    installTerminalFontZoomBridge(registry);

    let prevented = false;
    listeners[0]?.({
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      deltaY: -100,
      deltaMode: 0,
      target: {
        closest: () => ({ querySelector: () => focused.textarea }),
      },
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    } as unknown as Event);

    expect(focused.options.fontSize).toBe(13);
    expect(focused.fits).toEqual([{ forceRefresh: true, shouldClaim: true }]);
    expect(prevented).toBe(true);

    prevented = false;
    listeners[0]?.({
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      deltaY: -100,
      deltaMode: 0,
      target: { closest: () => null },
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {},
    } as unknown as Event);
    expect(focused.options.fontSize).toBe(13);
    expect(prevented).toBe(false);
    (globalThis as { document?: unknown }).document = previousDocument;
  });

  it("keeps a partial cmd wheel on one terminal and drops it when the pointer moves", () => {
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>();
    const first = terminal(12);
    const second = terminal(12);
    registry.register({ terminal: first, fit: first.fit, baseFontSize: 12 });
    registry.register({ terminal: second, fit: second.fit, baseFontSize: 12 });
    const listeners: Array<(event: Event) => void> = [];
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: { addEventListener: typeof document.addEventListener } }).document =
      {
        addEventListener(type, listener) {
          if (type === "wheel" && typeof listener === "function") listeners.push(listener);
        },
      } as Document;
    installTerminalFontZoomBridge(registry);

    const wheel = (pane: ReturnType<typeof terminal> | null, deltaY: number, metaKey = true) => {
      listeners[0]?.({
        ctrlKey: false,
        metaKey,
        altKey: false,
        shiftKey: false,
        deltaY,
        deltaMode: 0,
        target: {
          closest: () => (pane ? { querySelector: () => pane.textarea } : null),
        },
        preventDefault() {},
        stopPropagation() {},
      } as unknown as Event);
    };

    wheel(first, -80);
    wheel(second, -20);
    expect(first.options.fontSize).toBe(12);
    expect(second.options.fontSize).toBe(12);

    wheel(first, -40);
    wheel(first, -60);
    expect(first.options.fontSize).toBe(13);
    expect(second.options.fontSize).toBe(12);

    wheel(first, -80);
    wheel(null, -20);
    wheel(first, -20);
    expect(first.options.fontSize).toBe(13);
    (globalThis as { document?: unknown }).document = previousDocument;
  });

  it("saves the zoomed size and restores it on the next terminal", () => {
    const storage = memoryStorage();
    const first = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>(storage);
    const focused = terminal(12);
    first.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    expect(first.consume("in", focused.textarea)).toBe(true);
    expect(storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBe("13");

    const second = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>(storage);
    const remounted = terminal(12);
    second.register({ terminal: remounted, fit: remounted.fit, baseFontSize: 12 });
    expect(remounted.options.fontSize).toBe(13);
    expect(second.settingsFontSize(remounted, 18)).toBeNull();

    expect(second.consume("reset", remounted.textarea)).toBe(true);
    expect(remounted.options.fontSize).toBe(12);
    expect(storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBeNull();
  });

  it("ignores a stored size outside 8–32 and drops one that matches the settings font", () => {
    const tooBig = memoryStorage("99");
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>(tooBig);
    const focused = terminal(12);
    registry.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    expect(focused.options.fontSize).toBe(12);
    expect(registry.settingsFontSize(focused, 15)).toBe(15);

    const same = memoryStorage("12");
    const next = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>(same);
    const plain = terminal(12);
    next.register({ terminal: plain, fit: plain.fit, baseFontSize: 12 });
    expect(plain.options.fontSize).toBe(12);
    expect(same.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)).toBeNull();
  });

  it("keeps the live zoom when storage throws", () => {
    const storage: TerminalFontSizeStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    const registry = new TerminalFontZoomRegistry<ReturnType<typeof terminal>>(storage);
    const focused = terminal(12);
    registry.register({ terminal: focused, fit: focused.fit, baseFontSize: 12 });
    expect(registry.consume("in", focused.textarea)).toBe(true);
    expect(focused.options.fontSize).toBe(13);
  });
});
