import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadActiveBrowserOrWindow, setupApplicationMenu } from "./menu.js";

const electronMocks = vi.hoisted(() => {
  const appMenuInsert = vi.fn();
  return {
    appMenuInsert,
    buildFromTemplate: vi.fn((template: unknown) => ({
      getMenuItemById: vi.fn((id: string) =>
        id === "application-menu"
          ? {
              submenu: {
                insert: appMenuInsert,
                items: [{ role: "about" }, { type: "separator" }, { role: "services" }],
              },
            }
          : null,
      ),
      template,
    })),
    setApplicationMenu: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: class BrowserWindow {
    public readonly webContents = {};

    public static getFocusedWindow(): null {
      return null;
    }

    public static fromWebContents(): null {
      return null;
    }
  },
  ipcMain: { handle: vi.fn() },
  Menu: electronMocks,
  MenuItem: class MenuItem {
    public constructor(public readonly options: unknown) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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

describe("setupApplicationMenu", () => {
  it("adds Preferences to Electron's native macOS application and Window menus", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    setupApplicationMenu({ onNewWindow: vi.fn() });

    const template = electronMocks.buildFromTemplate.mock.calls[0]?.[0];
    expect(template).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "application-menu", role: "appMenu" }),
        expect.objectContaining({ role: "windowMenu" }),
      ]),
    );
    expect(electronMocks.appMenuInsert).toHaveBeenNthCalledWith(
      1,
      2,
      expect.objectContaining({
        options: expect.objectContaining({
          label: "Preferences…",
          accelerator: "Command+,",
          click: expect.any(Function),
        }),
      }),
    );
    expect(electronMocks.appMenuInsert).toHaveBeenNthCalledWith(
      2,
      3,
      expect.objectContaining({
        options: expect.objectContaining({ type: "separator" }),
      }),
    );
  });
});
