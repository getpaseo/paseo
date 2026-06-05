import { app, Menu, BrowserWindow, ipcMain } from "electron";
import { getWorkspaceActivePaseoBrowserWebContents } from "./browser-webviews.js";

interface ShowContextMenuInput {
  kind?: "terminal";
  hasSelection?: boolean;
}

interface ApplicationMenuOptions {
  onNewWindow: () => void;
}

function withBrowserWindow(
  callback: (win: BrowserWindow) => void,
): (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => void {
  return (_item, baseWin) => {
    const win = baseWin instanceof BrowserWindow ? baseWin : BrowserWindow.getFocusedWindow();
    if (win) callback(win);
  };
}

function getReloadTargetBrowserWebContents(): Electron.WebContents | null {
  return getWorkspaceActivePaseoBrowserWebContents();
}

function reloadFocusedContentsOrWindow(win: BrowserWindow, options?: { ignoreCache?: boolean }) {
  const browserContents = getReloadTargetBrowserWebContents();
  if (browserContents) {
    if (options?.ignoreCache) {
      browserContents.reloadIgnoringCache();
      return;
    }
    if (browserContents.isLoadingMainFrame()) {
      browserContents.stop();
      return;
    }
    browserContents.reload();
    return;
  }

  if (options?.ignoreCache) {
    win.webContents.reloadIgnoringCache();
    return;
  }
  win.webContents.reload();
}

function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            options.onNewWindow();
          },
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
          }),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
          }),
        },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(0);
          }),
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: withBrowserWindow((win) => {
            reloadFocusedContentsOrWindow(win);
          }),
        },
        {
          label: "Force Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: withBrowserWindow((win) => {
            reloadFocusedContentsOrWindow(win, { ignoreCache: true });
          }),
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];
}

export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  const menu = Menu.buildFromTemplate(buildApplicationMenuTemplate(options));
  Menu.setApplicationMenu(menu);

  ipcMain.handle("paseo:menu:showContextMenu", (event, input?: ShowContextMenuInput) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    if (input?.kind !== "terminal") {
      return;
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Copy",
        role: "copy",
        enabled: input.hasSelection === true,
      },
      {
        label: "Paste",
        role: "paste",
      },
      {
        type: "separator",
      },
      {
        label: "Select All",
        role: "selectAll",
      },
    ]);

    contextMenu.popup({ window: win });
  });
}
