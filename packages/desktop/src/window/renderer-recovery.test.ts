import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { reloadWhenRendererExits } from "./renderer-recovery.js";

class Contents extends EventEmitter {
  reloads = 0;
  url = "paseo://app/";
  getURL() {
    return this.url;
  }
  reload() {
    this.reloads += 1;
  }
  exit(reason: string) {
    this.emit("render-process-gone", {}, { reason, exitCode: reason === "clean-exit" ? 0 : 15 });
  }
}

class Window {
  webContents = new Contents();
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
}

function recoverableWindow() {
  const win = new Window();
  let time = 0;
  reloadWhenRendererExits(win, { now: () => time });
  return {
    win,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe("reloadWhenRendererExits", () => {
  it("reloads the window when its renderer is killed", () => {
    const { win } = recoverableWindow();
    win.webContents.exit("killed");
    expect(win.webContents.reloads).toBe(1);
  });

  it("reloads after a renderer crash or out-of-memory exit", () => {
    const { win, advance } = recoverableWindow();
    win.webContents.exit("crashed");
    advance(120_000);
    win.webContents.exit("oom");
    expect(win.webContents.reloads).toBe(2);
  });

  it("leaves a renderer that exited cleanly alone", () => {
    const { win } = recoverableWindow();
    win.webContents.exit("clean-exit");
    expect(win.webContents.reloads).toBe(0);
  });

  it("leaves a renderer that exits before the first page commits to Chromium", () => {
    const { win } = recoverableWindow();
    win.webContents.url = "";
    win.webContents.exit("killed");
    expect(win.webContents.reloads).toBe(0);
  });

  it("leaves a closed window closed", () => {
    const { win } = recoverableWindow();
    win.destroyed = true;
    win.webContents.exit("killed");
    expect(win.webContents.reloads).toBe(0);
  });

  it("stops reloading a renderer that keeps exiting, and recovers again later", () => {
    const { win, advance } = recoverableWindow();
    for (let exit = 0; exit < 5; exit += 1) {
      win.webContents.exit("crashed");
      advance(1_000);
    }
    expect(win.webContents.reloads).toBe(3);

    advance(60_000);
    win.webContents.exit("killed");
    expect(win.webContents.reloads).toBe(4);
  });
});
