import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ReadyToShowWindow, showWindowWhenReady } from "./show-when-ready.js";

function fakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  let destroyed = false;
  const win: ReadyToShowWindow & {
    shows: number;
    emit: (event: "ready-to-show" | "closed") => void;
    destroy: () => void;
  } = {
    shows: 0,
    once(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return win;
    },
    show() {
      win.shows += 1;
    },
    isDestroyed: () => destroyed,
    emit(event) {
      const queued = listeners.get(event) ?? [];
      listeners.set(event, []);
      for (const listener of queued) listener();
    },
    destroy() {
      destroyed = true;
    },
  };
  return win;
}

describe("showWindowWhenReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the window on ready-to-show and not again on the fallback", () => {
    const win = fakeWindow();
    showWindowWhenReady(win, { fallbackMs: 2_000 });
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(win.shows).toBe(1);
  });

  it("shows the window after the fallback when ready-to-show never fires", () => {
    const win = fakeWindow();
    showWindowWhenReady(win, { fallbackMs: 2_000 });
    vi.advanceTimersByTime(1_999);
    expect(win.shows).toBe(0);
    vi.advanceTimersByTime(1);
    expect(win.shows).toBe(1);
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
  });

  it("does nothing on the fallback once the window closed", () => {
    const win = fakeWindow();
    showWindowWhenReady(win, { fallbackMs: 2_000 });
    win.emit("closed");
    win.destroy();
    vi.advanceTimersByTime(5_000);
    expect(win.shows).toBe(0);
  });

  it("never shows a destroyed window from ready-to-show", () => {
    const win = fakeWindow();
    showWindowWhenReady(win, { fallbackMs: null });
    win.destroy();
    win.emit("ready-to-show");
    expect(win.shows).toBe(0);
  });

  it("keeps the old behaviour when the fallback is disabled", () => {
    const win = fakeWindow();
    showWindowWhenReady(win, { fallbackMs: null });
    vi.advanceTimersByTime(60_000);
    expect(win.shows).toBe(0);
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
  });
});
