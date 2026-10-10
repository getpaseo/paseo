import { describe, expect, it } from "vitest";
import { editUndoRedoMenuItems, reloadActiveBrowserOrWindow, runEditCommand } from "./menu.js";

class FakeWebContents {
  public readonly reloads: string[] = [];

  public constructor(public readonly id: number) {}

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }
}

class BrowserReloads {
  public readonly firstWindow = { webContents: new FakeWebContents(101) };
  public readonly secondWindow = { webContents: new FakeWebContents(202) };
  public readonly firstBrowser = new FakeWebContents(11);
  public readonly secondBrowser = new FakeWebContents(22);
  public readonly resolvedHostWindowIds: number[] = [];

  public activeBrowserForHostWindow(hostWebContentsId: number): FakeWebContents | null {
    this.resolvedHostWindowIds.push(hostWebContentsId);
    return hostWebContentsId === 101 ? this.firstBrowser : this.secondBrowser;
  }
}

describe("reloadActiveBrowserOrWindow", () => {
  it("reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.firstWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([101]);
    expect(browserReloads.firstBrowser.reloads).toEqual(["reload"]);
    expect(browserReloads.secondBrowser.reloads).toEqual([]);
    expect(browserReloads.firstWindow.webContents.reloads).toEqual([]);
  });

  it("force reloads only the active browser belonging to the supplied window", () => {
    const browserReloads = new BrowserReloads();

    reloadActiveBrowserOrWindow({
      win: browserReloads.secondWindow,
      getActiveBrowserContentsForHostWindow:
        browserReloads.activeBrowserForHostWindow.bind(browserReloads),
      ignoreCache: true,
    });

    expect(browserReloads.resolvedHostWindowIds).toEqual([202]);
    expect(browserReloads.firstBrowser.reloads).toEqual([]);
    expect(browserReloads.secondBrowser.reloads).toEqual(["force-reload"]);
    expect(browserReloads.secondWindow.webContents.reloads).toEqual([]);
  });
});

class FakeEditTarget {
  public readonly calls: string[] = [];
  public constructor(private readonly destroyed: boolean) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public undo(): void {
    this.calls.push("undo");
  }

  public redo(): void {
    this.calls.push("redo");
  }
}

function invokeMenuItem(item: Electron.MenuItemConstructorOptions): void {
  const click = item.click;
  if (!click) {
    throw new Error(`menu item ${item.label} has no click`);
  }
  click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
}

describe("edit undo and redo", () => {
  it("sends undo to the focused page", () => {
    const focused = new FakeEditTarget(false);
    const windowContents = new FakeEditTarget(false);

    runEditCommand({ method: "undo", focused, windowContents });

    expect(focused.calls).toEqual(["undo"]);
    expect(windowContents.calls).toEqual([]);
  });

  it("falls back to the window when the focused page is gone", () => {
    const focused = new FakeEditTarget(true);
    const windowContents = new FakeEditTarget(false);

    runEditCommand({ method: "redo", focused, windowContents });

    expect(focused.calls).toEqual([]);
    expect(windowContents.calls).toEqual(["redo"]);
  });

  it("does nothing when neither page can take the command", () => {
    const focused = new FakeEditTarget(true);
    const windowContents = new FakeEditTarget(true);

    runEditCommand({ method: "undo", focused: null, windowContents });
    runEditCommand({ method: "undo", focused, windowContents: null });

    expect(focused.calls).toEqual([]);
    expect(windowContents.calls).toEqual([]);
  });

  it("registers Cmd+Z and Shift+Cmd+Z without the native undo role", () => {
    const calls: Array<"undo" | "redo"> = [];
    const items = editUndoRedoMenuItems("darwin", (method) => () => {
      calls.push(method);
    });

    expect(items.map((item) => [item.label, item.accelerator, item.role ?? null])).toEqual([
      ["Undo", "CmdOrCtrl+Z", null],
      ["Redo", "Shift+CmdOrCtrl+Z", null],
    ]);

    invokeMenuItem(items[0]);
    invokeMenuItem(items[1]);
    expect(calls).toEqual(["undo", "redo"]);
  });

  it("keeps Windows redo on Control+Y", () => {
    const calls: Array<"undo" | "redo"> = [];
    const items = editUndoRedoMenuItems("win32", (method) => () => {
      calls.push(method);
    });

    expect(items.map((item) => [item.label, item.accelerator, item.role ?? null])).toEqual([
      ["Undo", "CmdOrCtrl+Z", null],
      ["Redo", "Control+Y", null],
    ]);

    invokeMenuItem(items[1]);
    expect(calls).toEqual(["redo"]);
  });
});
