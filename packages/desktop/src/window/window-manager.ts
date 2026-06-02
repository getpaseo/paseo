import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
  clipboard,
  ipcMain,
  nativeTheme,
  shell,
} from "electron";

import type { WindowState, WindowStateStore } from "../settings/window-state.js";

const WINDOW_STATE_SAVE_DEBOUNCE_MS = 400;

export function readBadgeCount(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return 0;
  }

  return input;
}

export type WindowTheme = "light" | "dark";
export interface WindowControlsOverlayUpdate {
  height?: number;
  backgroundColor?: string;
  foregroundColor?: string;
}

export interface WindowControlsOverlayState {
  height: number;
  backgroundColor?: string;
  foregroundColor?: string;
}

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

export const DEFAULT_WINDOW_WIDTH = 1200;
export const DEFAULT_WINDOW_HEIGHT = 800;

/**
 * Window size/position options for the BrowserWindow constructor, derived from
 * a restored state when available. Falls back to the default size, and only
 * sets x/y when a full position was persisted (a partial state lets the OS
 * place the window).
 */
export function resolveWindowBounds(
  state: WindowState | null,
): Pick<Electron.BrowserWindowConstructorOptions, "width" | "height" | "x" | "y"> {
  const width = state?.width ?? DEFAULT_WINDOW_WIDTH;
  const height = state?.height ?? DEFAULT_WINDOW_HEIGHT;
  if (state?.x !== undefined && state?.y !== undefined) {
    return { width, height, x: state.x, y: state.y };
  }
  return { width, height };
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

export function readWindowControlsOverlayUpdate(
  input: unknown,
): WindowControlsOverlayUpdate | null {
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

/**
 * Persist the window's size/position/maximized state so it can be restored on
 * the next launch. Debounces disk writes on resize/move, writes immediately on
 * maximize/unmaximize, and flushes synchronously on close so the final state
 * survives quit/reboot. The latest geometry is captured into memory on every
 * event so a queued async write can never overwrite the close-time snapshot.
 */
export function setupWindowStatePersistence(win: BrowserWindow, store: WindowStateStore): void {
  let latestState: WindowState | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let flushed = false;

  function clearTimer(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  function captureState(): void {
    // Skip transient geometry: maximized/fullscreen bounds aren't the size we
    // want to restore to, and a minimized window reports misleading bounds.
    if (win.isMinimized() || win.isFullScreen()) {
      return;
    }
    const bounds = win.getNormalBounds();
    latestState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    };
  }

  function persist(): void {
    if (latestState) {
      void store.save(latestState).catch((error) => {
        console.warn("[window-manager] Failed to persist window state", error);
      });
    }
  }

  function scheduleSave(): void {
    captureState();
    clearTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
  }

  function saveNow(): void {
    captureState();
    clearTimer();
    persist();
  }

  // Final synchronous flush. Runs on window close AND on app quit: the app's
  // before-quit handler calls app.exit(0), which bypasses the window close
  // event (see daemon/quit-lifecycle.ts), so close alone would miss Cmd+Q.
  function flushFinal(): void {
    if (flushed) {
      return;
    }
    flushed = true;
    clearTimer();
    captureState();
    if (latestState) {
      try {
        store.saveSync(latestState);
      } catch (error) {
        console.warn("[window-manager] Failed to persist window state on exit", error);
      }
    }
  }

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", saveNow);
  win.on("unmaximize", saveNow);
  win.on("close", flushFinal);
  app.on("before-quit", flushFinal);

  win.on("closed", () => {
    clearTimer();
    app.removeListener("before-quit", flushFinal);
  });
}

export function buildStandardContextMenuItems(
  contents: WebContents,
  params: Electron.ContextMenuParams,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        items.push({
          label: suggestion,
          click: () => contents.replaceMisspelling(suggestion),
        });
      }
    } else {
      items.push({ label: "No suggestions", enabled: false });
    }
    items.push({ type: "separator" });
    items.push({
      label: "Add to Dictionary",
      click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: "separator" });
  }

  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    items.push({
      label: "Open Link in Browser",
      click: () => {
        void shell.openExternal(params.linkURL);
      },
    });
    items.push({
      label: "Copy Link Address",
      click: () => clipboard.writeText(params.linkURL),
    });
    items.push({ type: "separator" });
  }

  if (params.hasImageContents && params.srcURL) {
    items.push({
      label: "Copy Image",
      click: () => contents.copyImageAt(params.x, params.y),
    });
    items.push({
      label: "Save Image As…",
      click: () => contents.downloadURL(params.srcURL),
    });
    items.push({ type: "separator" });
  }

  if (params.isEditable) {
    items.push({ role: "cut", enabled: params.editFlags.canCut });
    items.push({ role: "copy", enabled: params.editFlags.canCopy });
    items.push({ role: "paste", enabled: params.editFlags.canPaste });
    items.push({ type: "separator" });
    items.push({ role: "selectAll" });
  } else {
    items.push({ role: "copy", enabled: params.selectionText.length > 0 });
    items.push({ role: "paste" });
    items.push({ type: "separator" });
    items.push({ role: "selectAll" });
  }

  return items;
}

export function setupDefaultContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate(buildStandardContextMenuItems(win.webContents, params));
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
