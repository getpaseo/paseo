import { app, BrowserWindow, Menu, ipcMain, nativeTheme } from "electron";

export function readBadgeCount(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return 0;
  }

  return input;
}

export type WindowTheme = "light" | "dark";
export type WindowControlsOverlayUpdate = {
  height?: number;
  backgroundColor?: string;
  foregroundColor?: string;
};

export type WindowControlsOverlayState = {
  height: number;
  backgroundColor?: string;
  foregroundColor?: string;
};

export function readWindowTheme(input: unknown): WindowTheme | null {
  if (input === "light" || input === "dark") {
    return input;
  }

  return null;
}

export function resolveSystemWindowTheme(): WindowTheme {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function getWindowBackgroundColor(theme: WindowTheme): string {
  return theme === "dark" ? "#181B1A" : "#ffffff";
}

export function createWindowControlsOverlayState(theme: WindowTheme): WindowControlsOverlayState {
  const overlay = getTitleBarOverlayOptions(theme);
  return {
    height: overlay.height ?? 29,
    backgroundColor: overlay.color,
    foregroundColor: overlay.symbolColor,
  };
}

export function getTitleBarOverlayOptions(theme: WindowTheme): Electron.TitleBarOverlayOptions {
  if (theme === "dark") {
    return { color: "#181B1A", symbolColor: "#e4e4e7", height: 29 };
  }

  return { color: "#ffffff", symbolColor: "#09090b", height: 29 };
}

export function getMainWindowChromeOptions(input: {
  platform: NodeJS.Platform;
  theme: WindowTheme;
}): Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "frame" | "titleBarOverlay" | "autoHideMenuBar"
> {
  if (input.platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: true,
      trafficLightPosition: { x: 16, y: 14 },
    };
  }

  return {
    titleBarStyle: "hidden",
    frame: false,
    titleBarOverlay: getTitleBarOverlayOptions(input.theme),
    autoHideMenuBar: true,
  };
}

function readFiniteOverlayHeight(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return null;
  }

  const rounded = Math.round(input);
  return rounded >= 1 ? rounded : null;
}

function readOverlayColor(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }

  return input;
}

export function readWindowControlsOverlayUpdate(input: unknown): WindowControlsOverlayUpdate | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Record<string, unknown>;
  const height = readFiniteOverlayHeight(candidate.height);
  const backgroundColor = readOverlayColor(candidate.backgroundColor);
  const foregroundColor = readOverlayColor(candidate.foregroundColor);

  if (height === null && backgroundColor === null && foregroundColor === null) {
    return null;
  }

  return {
    ...(height !== null ? { height } : {}),
    ...(backgroundColor !== null ? { backgroundColor } : {}),
    ...(foregroundColor !== null ? { foregroundColor } : {}),
  };
}

export function resolveRuntimeTitleBarOverlayOptions(
  state: WindowControlsOverlayState,
): Electron.TitleBarOverlayOptions {
  return {
    color: state.backgroundColor?.trim() === "" ? undefined : state.backgroundColor,
    symbolColor: state.foregroundColor?.trim() === "" ? undefined : state.foregroundColor,
    height: Math.max(0, state.height - 1),
  };
}

export function applyWindowControlsOverlayUpdate(input: {
  win: Pick<BrowserWindow, "setTitleBarOverlay">;
  current: WindowControlsOverlayState;
  update: WindowControlsOverlayUpdate;
}): WindowControlsOverlayState {
  const next: WindowControlsOverlayState = {
    height: input.update.height ?? input.current.height,
    backgroundColor: input.update.backgroundColor ?? input.current.backgroundColor,
    foregroundColor: input.update.foregroundColor ?? input.current.foregroundColor,
  };

  input.win.setTitleBarOverlay(resolveRuntimeTitleBarOverlayOptions(next));
  return next;
}

export function registerWindowManager(): void {
  const overlayStateByWindow = new WeakMap<BrowserWindow, WindowControlsOverlayState>();

  ipcMain.handle("paseo:window:toggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle("paseo:window:isFullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFullScreen() ?? false;
  });

  ipcMain.handle("paseo:window:setBadgeCount", (_event, count?: unknown) => {
    if (process.platform === "darwin" || process.platform === "linux") {
      const badgeCount = readBadgeCount(count);
      try {
        app.setBadgeCount(badgeCount);
      } catch (error) {
        console.warn("[window-manager] Failed to update badge count", {
          count,
          badgeCount,
          error,
        });
      }
    }
  });

  ipcMain.handle("paseo:window:updateWindowControls", (event, update?: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    const nextUpdate = readWindowControlsOverlayUpdate(update);
    if (!nextUpdate) {
      return;
    }

    if (nextUpdate.backgroundColor) {
      win.setBackgroundColor(nextUpdate.backgroundColor);
    }

    if (process.platform === "darwin") {
      return;
    }

    const current =
      overlayStateByWindow.get(win) ?? createWindowControlsOverlayState(resolveSystemWindowTheme());
    const nextState = applyWindowControlsOverlayUpdate({
      win,
      current,
      update: nextUpdate,
    });
    overlayStateByWindow.set(win, nextState);
  });
}

export function setupWindowResizeEvents(win: BrowserWindow): void {
  win.on("resize", () => {
    win.webContents.send("paseo:window:resized", {});
  });

  win.on("enter-full-screen", () => {
    win.webContents.send("paseo:window:resized", {});
  });

  win.on("leave-full-screen", () => {
    win.webContents.send("paseo:window:resized", {});
  });
}

export function setupDefaultContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: "copy", enabled: params.selectionText.length > 0 },
      { role: "paste" },
      { type: "separator" },
      { role: "selectAll" },
    ]);
    menu.popup({ window: win });
  });
}

/**
 * Prevent Electron from navigating to files dragged onto the window.
 * The renderer handles drag-drop via standard HTML5 APIs instead.
 */
export function setupDragDropPrevention(win: BrowserWindow): void {
  win.webContents.on("will-navigate", (event, url) => {
    // Allow normal navigation (e.g. dev server hot-reload) but block file:// URLs
    // that result from dropping files onto the window.
    if (url.startsWith("file://")) {
      event.preventDefault();
    }
  });
}
