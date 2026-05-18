import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
  clipboard,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell,
} from "electron";

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

// How often the main process probes the renderer for frame production.
const FRAME_PROBE_INTERVAL_MS = 2000;
// A probed frame must arrive within this window or the probe counts as stalled.
const FRAME_PROBE_DEADLINE_MS = 300;
// Consecutive stalled probes before the watchdog restarts the GPU process (~6 s).
const FRAME_STALL_CHECKS_TO_RECOVER = 3;
// Minimum gap between GPU-process restarts.
const COMPOSITOR_RECOVERY_COOLDOWN_MS = 60_000;
// Grace period for Chromium to relaunch the GPU process before probing resumes.
const GPU_RELAUNCH_GRACE_MS = 5_000;
// Stop restarting the GPU process after this many tries without frames returning.
const MAX_CONSECUTIVE_RECOVERIES = 3;

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

// Resolves { producedFrame, visibilityState } for the renderer. The frame is
// requested with requestAnimationFrame; setTimeout (not vsync-driven) bounds the
// wait so the probe always resolves even when frame production has stopped.
const FRAME_PROBE_SOURCE = `new Promise((resolve) => {
  let settled = false;
  const finish = (producedFrame) => {
    if (settled) return;
    settled = true;
    resolve({ producedFrame, visibilityState: document.visibilityState });
  };
  requestAnimationFrame(() => finish(true));
  setTimeout(() => finish(false), ${FRAME_PROBE_DEADLINE_MS});
})`;

interface FrameStallState {
  stalledChecks: number;
  recovering: boolean;
  msSinceLastRecovery: number;
  consecutiveRecoveries: number;
}

export function shouldRecoverFromFrameStall(state: FrameStallState): boolean {
  return (
    state.stalledChecks >= FRAME_STALL_CHECKS_TO_RECOVER &&
    !state.recovering &&
    state.msSinceLastRecovery >= COMPOSITOR_RECOVERY_COOLDOWN_MS &&
    state.consecutiveRecoveries < MAX_CONSECUTIVE_RECOVERIES
  );
}

function findGpuProcessPid(): number | null {
  for (const metric of app.getAppMetrics()) {
    if (metric.type === "GPU") {
      return metric.pid;
    }
  }
  return null;
}

// macOS display sleep can leave Chromium's GPU-process display link (the vsync
// source that drives frame production) stuck on a stale display. The compositor
// then stops producing frames and the window looks frozen — unresponsive to
// clicks and keys — even though the renderer and every process stay alive. This
// watchdog polls the renderer for frame production and, on a sustained stall,
// restarts the GPU process so Chromium rebuilds the display link.
export function setupDarwinCompositorWatchdog(win: BrowserWindow): void {
  if (process.platform !== "darwin") {
    return;
  }

  // Keep producing frames while occluded so the probe is not fooled by throttling.
  win.webContents.setBackgroundThrottling(false);

  let stalledChecks = 0;
  let recovering = false;
  let lastRecoveryAt = 0;
  let consecutiveRecoveries = 0;
  let screenLocked = false;

  const recoverCompositor = async () => {
    recovering = true;
    lastRecoveryAt = Date.now();
    consecutiveRecoveries += 1;
    stalledChecks = 0;
    const gpuPid = findGpuProcessPid();
    console.warn(
      `[window-manager] Desktop window stopped producing frames; restarting GPU process ` +
        `(pid=${gpuPid ?? "unknown"}, attempt ${consecutiveRecoveries}) to recover`,
    );
    if (gpuPid !== null) {
      try {
        process.kill(gpuPid, "SIGKILL");
      } catch (error) {
        console.warn("[window-manager] Could not restart GPU process", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, GPU_RELAUNCH_GRACE_MS));
    recovering = false;
  };

  const probeFrameProduction = async () => {
    if (win.isDestroyed() || recovering) {
      return;
    }
    // A freeze is only meaningful — and only distinguishable from a normal idle
    // window — while the window is actually on screen. A locked screen, a
    // minimized window, or a hidden one legitimately stops producing frames.
    if (screenLocked || !win.isVisible() || win.isMinimized()) {
      stalledChecks = 0;
      return;
    }

    let result: { producedFrame?: unknown; visibilityState?: unknown } | null;
    try {
      result = await win.webContents.executeJavaScript(FRAME_PROBE_SOURCE);
    } catch {
      return;
    }
    if (!result || result.visibilityState !== "visible") {
      stalledChecks = 0;
      return;
    }
    if (result.producedFrame === true) {
      stalledChecks = 0;
      consecutiveRecoveries = 0;
      return;
    }

    stalledChecks += 1;
    if (
      shouldRecoverFromFrameStall({
        stalledChecks,
        recovering,
        msSinceLastRecovery: Date.now() - lastRecoveryAt,
        consecutiveRecoveries,
      })
    ) {
      void recoverCompositor();
    }
  };

  const probeTimer = setInterval(() => void probeFrameProduction(), FRAME_PROBE_INTERVAL_MS);
  const handleScreenLocked = () => {
    screenLocked = true;
    stalledChecks = 0;
  };
  const handleScreenUnlocked = () => {
    screenLocked = false;
    stalledChecks = 0;
  };
  powerMonitor.on("lock-screen", handleScreenLocked);
  powerMonitor.on("unlock-screen", handleScreenUnlocked);

  win.once("closed", () => {
    clearInterval(probeTimer);
    powerMonitor.off("lock-screen", handleScreenLocked);
    powerMonitor.off("unlock-screen", handleScreenUnlocked);
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
