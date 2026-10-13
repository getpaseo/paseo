import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { showWindowWhenReady } from "./show-when-ready.js";

class Window extends EventEmitter {
  webContents = new EventEmitter();
  shows = 0;
  destroyed = false;
  show() {
    this.shows += 1;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
}

describe("showWindowWhenReady", () => {
  it("shows a loaded Linux window even when no initial frame was painted", () => {
    const win = new Window();
    showWindowWhenReady(win, { showOnLoad: true });
    expect(win.shows).toBe(0);
    win.webContents.emit("did-finish-load");
    expect(win.shows).toBe(1);
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
  });

  it("shows on the first frame without showing again after load", () => {
    const win = new Window();
    showWindowWhenReady(win, { showOnLoad: true });
    win.emit("ready-to-show");
    win.webContents.emit("did-finish-load");
    expect(win.shows).toBe(1);
  });

  it("preserves waiting for the initial frame when show on load is disabled", () => {
    const win = new Window();
    showWindowWhenReady(win, { showOnLoad: false });
    win.webContents.emit("did-finish-load");
    expect(win.shows).toBe(0);
    win.emit("ready-to-show");
    expect(win.shows).toBe(1);
  });

  it("keeps a closed window closed when readiness arrives later", () => {
    const win = new Window();
    showWindowWhenReady(win, { showOnLoad: true });
    win.close();
    win.webContents.emit("did-finish-load");
    win.emit("ready-to-show");
    expect(win.shows).toBe(0);
  });
});
