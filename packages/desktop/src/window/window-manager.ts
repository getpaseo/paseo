import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from "electron";

import type { WindowState, WindowStateStore } from "../settings/window-state.js";

const WINDOW_STATE_SAVE_DEBOUNCE_MS = 400;
const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const;
const MAX_TRAFFIC_LIGHT_OFFSET_Y = 10;

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
  trafficLightOffsetY?: number;
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
      trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    };
  }

  // SPIKE: no titleBarOverlay on Windows/Linux. The renderer draws the controls itself
  // (packages/app/src/components/desktop/window-controls.tsx) so they sit in the header's
  // own flex row and line up with the header icons. Without the overlay Chromium reports
  // navigator.windowControlsOverlay.visible === false, so nothing reserves a band.
  return {
    titleBarStyle: "hidden",
    frame: false,
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

function readTrafficLightOffsetY(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return null;
  }

  return Math.abs(input) <= MAX_TRAFFIC_LIGHT_OFFSET_Y ? input : null;
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
  const trafficLightOffsetY = readTrafficLightOffsetY(candidate.trafficLightOffsetY);

  if (
    height === null &&
    backgroundColor === null &&
    foregroundColor === null &&
    trafficLightOffsetY === null
  ) {
    return null;
  }

  return {
    ...(height !== null ? { height } : {}),
    ...(backgroundColor !== null ? { backgroundColor } : {}),
    ...(foregroundColor !== null ? { foregroundColor } : {}),
    ...(trafficLightOffsetY !== null ? { trafficLightOffsetY } : {}),
  };
}

export function applyMacWindowControlsUpdate(input: {
  win: Pick<BrowserWindow, "setWindowButtonPosition">;
  update: WindowControlsOverlayUpdate;
}): void {
  if (input.update.trafficLightOffsetY === undefined) {
    return;
  }

  input.win.setWindowButtonPosition({
    x: MAC_TRAFFIC_LIGHT_POSITION.x,
    y: MAC_TRAFFIC_LIGHT_POSITION.y + input.update.trafficLightOffsetY,
  });
}

export function registerWindowManager(): void {
  ipcMain.handle("paseo:window:toggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });

  ipcMain.handle("paseo:window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("paseo:window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("paseo:window:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle("paseo:window:isFullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFullScreen() ?? false;
  });

  ipcMain.handle("paseo:window:setFullscreen", (event, fullscreen: unknown) => {
    if (typeof fullscreen !== "boolean") return;
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(fullscreen);
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
    // macOS is the only platform with OS-drawn window buttons whose position we influence;
    // elsewhere the app draws its own controls, so there is no overlay to update.
    if (process.platform !== "darwin") {
      return;
    }

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

    applyMacWindowControlsUpdate({ win, update: nextUpdate });
  });
}

export function setupWindowResizeEvents(win: BrowserWindow): void {
  // A resize/fullscreen event can fire while the window is tearing down; sending
  // to a destroyed webContents throws. Guard so multi-window close doesn't surface
  // "Object has been destroyed" exceptions.
  const notifyResized = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      return;
    }
    win.webContents.send("paseo:window:resized", {});
  };

  win.on("resize", notifyResized);
  win.on("enter-full-screen", notifyResized);
  win.on("leave-full-screen", notifyResized);
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

/**
 * A frameless window draws its own controls in the renderer, so when the renderer dies or
 * hangs there is nothing left to click: the preload's boot controls are DOM too. Only the main
 * process can still offer a way out, which is why VS Code prompts from here rather than relying
 * on the titlebar (windowImpl.ts onWindowError). Without this the user has Alt+F4 or the
 * taskbar, and Ferdium shipped precisely that (ferdium/ferdium-app#230).
 */

/** Chromium reports an aborted load for ordinary navigation races; only real failures matter. */
const ERR_ABORTED = -3;

export function shouldReportLoadFailure(errorCode: number, isMainFrame: boolean): boolean {
  return isMainFrame && errorCode !== ERR_ABORTED;
}

export function shouldReportProcessGone(reason: string): boolean {
  // A clean exit is the renderer going away on purpose, e.g. while the window closes.
  return reason !== "clean-exit";
}

/** How long a requested close may take before the window is torn down regardless. */
const CLOSE_GRACE_MS = 2000;

/** How long after "Wait" to re-offer recovery if the renderer is still hung. */
const HUNG_RECHECK_MS = 20000;

interface WindowFailurePrompt {
  message: string;
  detail: string;
  waitable: boolean;
}

/**
 * Dismissing this dialog must never be the destructive choice. Electron's `cancelId` is the
 * button Escape and the dialog's own close box map to, so it points at the first button, which
 * is non-destructive in both shapes: Wait when the renderer may still recover, Reload when it
 * is already gone. Close is only ever reached by choosing it.
 */
export function buildFailurePromptButtons(waitable: boolean): {
  buttons: string[];
  defaultId: number;
  cancelId: number;
} {
  const buttons = waitable ? ["Wait", "Reload", "Close"] : ["Reload", "Close"];
  return { buttons, defaultId: 0, cancelId: 0 };
}

export function setupWindowFailureRecovery(win: BrowserWindow): void {
  let prompting = false;
  // A window can go unresponsive and then die while its dialog is still open. Dropping the
  // second event would leave the user answering a question about a renderer that no longer
  // exists, and "Wait" would dismiss the only recovery path they had. Queue instead.
  let queued: WindowFailurePrompt | null = null;
  let hung = false;
  let waitTimer: NodeJS.Timeout | null = null;

  function clearWaitTimer(): void {
    if (!waitTimer) return;
    clearTimeout(waitTimer);
    waitTimer = null;
  }

  /**
   * Forget that the renderer was ever hung. Anything that replaces or removes the renderer -
   * a reload, a close, a crash, a fresh load - ends the hang, and leaving the flag set would let
   * the re-check timer fire "This window is not responding" over a healthy replacement.
   */
  function clearHang(): void {
    hung = false;
    clearWaitTimer();
  }

  function closeWindow(): void {
    // close() rather than destroy(): the window-state persistence flush hangs off the close
    // event, and destroy() does not emit it, so tearing the window down directly would leave
    // the next launch restoring stale geometry. A hung renderer can still swallow the close,
    // so fall back to destroy() once the grace period is up.
    win.close();
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, CLOSE_GRACE_MS);
  }

  async function prompt(input: WindowFailurePrompt): Promise<void> {
    if (win.isDestroyed()) return;
    if (prompting) {
      // Keep the newest description of the problem; a crash supersedes a hang.
      queued = input;
      return;
    }
    prompting = true;
    let choice: string | undefined;
    try {
      const { buttons, defaultId, cancelId } = buildFailurePromptButtons(input.waitable);
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        buttons,
        defaultId,
        cancelId,
        message: input.message,
        detail: input.detail,
        noLink: true,
      });
      if (win.isDestroyed()) return;
      choice = buttons[response];
      if (choice === "Reload") {
        queued = null;
        clearHang();
        win.reload();
      } else if (choice === "Close") {
        queued = null;
        clearHang();
        closeWindow();
      }
    } catch {
      // The window can be closed from the taskbar, Alt+F4 or an app quit while this dialog is
      // open, which rejects showMessageBox with "Object has been destroyed". Nothing is left to
      // recover at that point, and these callers are fire-and-forget, so swallow it rather than
      // raise an unhandled rejection in the main process.
      return;
    } finally {
      prompting = false;
    }

    // Choosing Wait means "leave it alone", so an identical hang prompt must not reappear
    // immediately. Drop any queued hang, and re-offer only if the window is still hung later:
    // `unresponsive` fires once per episode, so without this a permanently hung window would
    // never be offered a way out again.
    if (choice === "Wait") {
      if (queued?.waitable) queued = null;
      clearWaitTimer();
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (hung && !win.isDestroyed()) void prompt(input);
      }, HUNG_RECHECK_MS);
    }

    const next = queued;
    queued = null;
    if (next && !win.isDestroyed()) {
      await prompt(next);
    }
  }

  // Keep the wording window-scoped. "<app> has stopped working" is what Windows says when a
  // process is gone for good, and it reads as terminal; only this window's renderer died, the
  // app is still running, and Reload fixes it. VS Code words its prompts the same way.
  win.on("unresponsive", () => {
    hung = true;
    void prompt({
      message: "This window is not responding",
      detail: "Wait for it to recover, reload it, or close it.",
      waitable: true,
    });
  });

  win.on("responsive", () => {
    clearHang();
    if (queued?.waitable) queued = null;
  });

  win.on("closed", clearWaitTimer);

  // A fresh load means a live renderer, so every failure this window was in is over: the hang,
  // and anything still queued behind an open dialog. Keeping the queue would put "This window
  // has crashed" over the healthy replacement, with its Reload and Close acting on a window
  // that already recovered. This also covers reloads the user triggers from the menu rather
  // than from the dialog.
  win.webContents.on("did-finish-load", () => {
    clearHang();
    queued = null;
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    // A gone renderer is not a hung one; without this the re-check timer would offer the hang
    // prompt again over whatever replaces it.
    clearHang();
    if (!shouldReportProcessGone(details.reason)) return;
    void prompt({
      message: "This window has crashed",
      detail: `Its renderer exited (${details.reason}). Reload the window, or close it.`,
      waitable: false,
    });
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!shouldReportLoadFailure(errorCode, isMainFrame)) return;
    void prompt({
      message: "This window could not load",
      detail: `${errorDescription} (${errorCode}). Reload the window, or close it.`,
      waitable: false,
    });
  });
}
