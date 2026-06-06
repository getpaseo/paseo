process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  session,
} from "electron";
import { createDaemonCommandHandlers, registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  resolveWindowBounds,
  setupWindowResizeEvents,
  setupWindowStatePersistence,
  setupDefaultContextMenu,
  setupDragDropPrevention,
  buildStandardContextMenuItems,
} from "./window/window-manager.js";
import { setupDarwinCompositorWatchdog } from "./window/compositor-watchdog/index.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { registerEditorTargetHandlers } from "./features/editor-targets.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContents,
  handleBrowserWindowOpenRequest,
  listRegisteredPaseoBrowserIds,
  readBrowserIdFromWebviewAttach,
  registerBrowserWebviewNavigationGuards,
  registerPaseoBrowserWebContents,
  setWorkspaceActivePaseoBrowserId,
} from "./features/browser-webviews/index.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { PendingOpenProjectStore } from "./pending-open-project-store.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createBeforeQuitHandler,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import { autoUpdateInstalledSkills } from "./integrations/skills/index.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "paseo";
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";
const DISABLE_SINGLE_INSTANCE_LOCK = process.env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK === "1";
const APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "Paseo";

const BROWSER_SHORTCUT_EVENT = "paseo:event:browser-shortcut";
const BROWSER_FORWARDED_KEY_EVENT = "paseo:event:browser-forwarded-key";

const FORWARDED_PASEO_SHORTCUT_KEYS = new Set([
  "b",
  "e",
  "w",
  "t",
  "k",
  "/",
  "\\",
  ",",
  ".",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "enter",
  "arrowleft",
  "arrowright",
  "arrowup",
  "arrowdown",
]);
const DESKTOP_SMOKE_ENV = "PASEO_DESKTOP_SMOKE";
const DESKTOP_SMOKE_STOP_REQUEST = "paseo-smoke-stop";
app.setName(APP_NAME);

const pendingBrowserWebviewIds: string[] = [];

function isBrowserRefreshInput(input: Electron.Input): boolean {
  if (input.type !== "keyDown" || input.alt || input.shift) {
    return false;
  }
  return (input.meta || input.control) && input.key.toLowerCase() === "r";
}

function isBrowserLocationInput(input: Electron.Input): boolean {
  if (input.type !== "keyDown" || input.alt || input.shift) {
    return false;
  }
  return (input.meta || input.control) && input.key.toLowerCase() === "l";
}

function isForwardablePaseoShortcutInput(input: Electron.Input): boolean {
  if (input.type !== "keyDown") {
    return false;
  }
  if (!input.meta && !input.control) {
    return false;
  }
  return FORWARDED_PASEO_SHORTCUT_KEYS.has(input.key.toLowerCase());
}

function showBrowserWebviewContextMenu(
  win: BrowserWindow,
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): void {
  const menu = Menu.buildFromTemplate([
    ...buildStandardContextMenuItems(contents, params),
    ...(app.isPackaged
      ? []
      : [
          { type: "separator" as const },
          {
            label: "Inspect Element",
            click: () => {
              log.info("[browser-devtools] inspect-element.request", {
                webContentsId: contents.id,
                browserId: getPaseoBrowserIdForWebContents(contents),
                x: params.x,
                y: params.y,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
              contents.openDevTools({ mode: "detach" });
              contents.inspectElement(params.x, params.y);
              log.info("[browser-devtools] inspect-element.done", {
                webContentsId: contents.id,
                isDevToolsOpened: contents.isDevToolsOpened(),
              });
            },
          },
        ]),
  ]);
  menu.popup({ window: win });
}

// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
const forcedUserDataDir = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
if (forcedUserDataDir) {
  app.setPath("userData", forcedUserDataDir);
  log.info("[dev-user-data] forced userData dir:", forcedUserDataDir);
} else if (!app.isPackaged) {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "paseo") gets default userData — only worktrees diverge.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      }).trim(),
    );
    const isWorktree = path.resolve(topLevel, ".git") !== commonDir;
    if (isWorktree) {
      app.setPath("userData", path.join(app.getPath("appData"), `Paseo-${devWorktreeName}`));
      log.info("[worktree] isolated userData for worktree:", devWorktreeName);
    } else {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

// AppImage runtimes mount the app from /tmp under the user's UID, so the SUID
// chrome-sandbox helper we ship in .deb/.rpm cannot work there. Disable the
// sandbox only in that case; .deb/.rpm keep the sandbox on, matching VS Code.
if (process.platform === "linux" && process.env.APPIMAGE) {
  app.commandLine.appendSwitch("no-sandbox");
}

// Allow users to pass Chromium flags via PASEO_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.PASEO_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});

// Each window pulls its own pending open-project path on mount, keyed by
// webContents id, so deep-linked windows (second-instance launches, the
// in-app "Open in new window" action) land on the right project without
// racing a global.
const pendingOpenProjectStore = new PendingOpenProjectStore();

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("paseo:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = pendingOpenProjectStore.take(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

ipcMain.handle("paseo:browser:set-workspace-active-browser", (_event, browserId: unknown) => {
  setWorkspaceActivePaseoBrowserId(typeof browserId === "string" ? browserId : null);
});

ipcMain.handle("paseo:browser:open-devtools", (_event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    const result = {
      ok: false,
      reason: "invalid-browser-id",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.invalid", result);
    return result;
  }
  const contents = getPaseoBrowserWebContents(browserId);
  if (!contents) {
    const result = {
      ok: false,
      reason: "browser-webcontents-not-found",
      browserId,
      registeredBrowserIds: listRegisteredPaseoBrowserIds(),
    };
    log.warn("[browser-devtools] open-devtools.not-found", result);
    return result;
  }
  log.info("[browser-devtools] open-devtools.request", {
    browserId,
    webContentsId: contents.id,
    isDestroyed: contents.isDestroyed(),
    isDevToolsOpened: contents.isDevToolsOpened(),
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  contents.openDevTools({ mode: "detach" });
  const result = {
    ok: true,
    reason: "opened",
    browserId,
    webContentsId: contents.id,
    isDevToolsOpened: contents.isDevToolsOpened(),
  };
  log.info("[browser-devtools] open-devtools.done", result);
  return result;
});

ipcMain.handle("paseo:browser:clear-partition", async (_event, browserId: unknown) => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    return;
  }
  const partition = `persist:paseo-browser-${browserId}`;
  await session.fromPartition(partition).clearStorageData();
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getAppDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app-dist");
  }

  return path.resolve(__dirname, "../../app/dist");
}

function getWindowIconCandidates(): string[] {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return [
        path.join(process.resourcesPath, "icon.ico"),
        path.join(process.resourcesPath, "icon.png"),
      ];
    }
    return [path.join(process.resourcesPath, "icon.png")];
  }
  if (process.platform === "win32") {
    return [
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [path.resolve(__dirname, "../assets/icon.png")];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function applyAppIcon(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const iconPath = path.resolve(__dirname, "../assets/icon.png");
  if (!existsSync(iconPath)) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

// Work areas with the primary display first, so window-state clamping treats
// it as the fallback. getAllDisplays() order is not guaranteed to lead with it.
function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

async function createWindow(
  options: {
    pendingOpenProjectPath?: string | null;
    restoreWindowState?: boolean;
  } = {},
): Promise<BrowserWindow> {
  const iconPath = getWindowIconPath();
  const systemTheme = resolveSystemWindowTheme();

  // Only the first window of a session restores and persists saved geometry.
  // Additional windows (⌘N, second-instance, "Open in new window") open at the
  // default size and let the OS cascade them, so they neither stack on top of
  // the restored window nor fight over the single window-state store.
  const restoreWindowState = options.restoreWindowState ?? false;
  const windowStateStore = restoreWindowState
    ? createWindowStateStore({ userDataPath: app.getPath("userData") })
    : null;
  const savedWindowState = windowStateStore ? await windowStateStore.load() : null;
  const restoredWindowState = savedWindowState
    ? clampWindowStateToWorkAreas(savedWindowState, getWorkAreasPrimaryFirst())
    : null;

  const title = devWorktreeName ? `${APP_NAME} (${devWorktreeName})` : APP_NAME;
  const mainWindow = new BrowserWindow({
    title,
    ...resolveWindowBounds(restoredWindowState),
    show: false,
    backgroundColor: getWindowBackgroundColor(systemTheme),
    ...(iconPath ? { icon: iconPath } : {}),
    ...getMainWindowChromeOptions({
      platform: process.platform,
      theme: systemTheme,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const webContentsId = mainWindow.webContents.id;
  pendingOpenProjectStore.set(webContentsId, options.pendingOpenProjectPath);
  mainWindow.on("closed", () => {
    pendingOpenProjectStore.delete(webContentsId);
  });

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  if (restoredWindowState?.isMaximized) {
    mainWindow.maximize();
  }

  setupDarwinCompositorWatchdog(mainWindow);
  setupWindowResizeEvents(mainWindow);
  if (windowStateStore) {
    setupWindowStatePersistence(mainWindow, windowStateStore);
  }
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const browserId = readBrowserIdFromWebviewAttach(params);
    if (!browserId) {
      event.preventDefault();
      return;
    }
    pendingBrowserWebviewIds.push(browserId);
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.webviewTag = false;
    webPreferences.allowRunningInsecureContent = false;
    delete webPreferences.preload;
    delete params.preload;
    delete (webPreferences as { preloadURL?: string }).preloadURL;
    delete (params as { preloadURL?: string }).preloadURL;
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    const browserId = pendingBrowserWebviewIds.shift() ?? null;
    if (browserId) {
      registerPaseoBrowserWebContents(contents, browserId);
      log.info("[browser-webview] registered", {
        browserId,
        webContentsId: contents.id,
        registeredBrowserIds: listRegisteredPaseoBrowserIds(),
      });
    }
    contents.on("before-input-event", (event, input) => {
      if (isBrowserRefreshInput(input)) {
        event.preventDefault();
        if (contents.isLoadingMainFrame()) {
          contents.stop();
        } else {
          contents.reload();
        }
        return;
      }
      if (isBrowserLocationInput(input)) {
        event.preventDefault();
        const focusedBrowserId = getPaseoBrowserIdForWebContents(contents);
        mainWindow.webContents.send(BROWSER_SHORTCUT_EVENT, {
          action: "focus-url",
          ...(focusedBrowserId ? { browserId: focusedBrowserId } : {}),
        });
        return;
      }
      if (isForwardablePaseoShortcutInput(input)) {
        event.preventDefault();
        mainWindow.webContents.send(BROWSER_FORWARDED_KEY_EVENT, {
          key: input.key,
          code: input.code,
          meta: input.meta,
          control: input.control,
          shift: input.shift,
          alt: input.alt,
        });
      }
    });
    contents.setWindowOpenHandler(({ url }) =>
      handleBrowserWindowOpenRequest({
        url,
        sourceBrowserId: getPaseoBrowserIdForWebContents(contents),
        requestNewTab: (payload) => {
          mainWindow.webContents.send(BROWSER_NEW_TAB_REQUEST_EVENT, payload);
        },
      }),
    );
    contents.on("context-menu", (_contextMenuEvent, params) => {
      showBrowserWebviewContextMenu(mainWindow, contents, params);
    });
    registerBrowserWebviewNavigationGuards(contents);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    await mainWindow.loadURL(DEV_SERVER_URL);
    return mainWindow;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app/`);
  return mainWindow;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Resolves once bootstrap() has registered the custom protocol handler and IPC
// handlers and created the first window. second-instance window creation waits
// on this rather than app.whenReady(): in packaged mode createWindow loads
// `paseo://app/`, which fails if the protocol handler isn't registered yet, and
// a second instance can arrive mid-cold-start.
let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});

function setupSingleInstanceLock(): boolean {
  if (DISABLE_SINGLE_INSTANCE_LOCK) {
    log.info("[single-instance] disabled by PASEO_DISABLE_SINGLE_INSTANCE_LOCK");
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return false;
  }

  app.on("second-instance", (_event, commandLine) => {
    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);
    // Relaunching the app (CLI `paseo [path]`, double-click, etc.) opens a new
    // window rather than focusing the existing one. Wait for bootstrap (not just
    // app.whenReady) so the protocol + IPC handlers exist before the window loads.
    void bootstrapComplete
      .then(() => createWindow({ pendingOpenProjectPath: openProjectPath }))
      .catch((error) => {
        log.error("[window] failed to create window from second-instance", error);
      });
  });

  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parsePassthroughCliArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = await runPassthroughCli(cliArgs);
    app.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    app.exit(1);
  }

  return true;
}

async function runDesktopSmokeIfRequested(): Promise<boolean> {
  if (process.env[DESKTOP_SMOKE_ENV] !== "1") {
    return false;
  }

  const handlers = createDaemonCommandHandlers();
  const startStatus = await handlers.start_desktop_daemon();
  process.stdout.write(
    `[paseo-smoke] ${JSON.stringify({
      type: "desktop-daemon-smoke-started",
      status: startStatus,
    })}\n`,
  );

  await waitForDesktopSmokeStopRequest();

  const stopStatus = await handlers.stop_desktop_daemon();
  process.stdout.write(
    `[paseo-smoke] ${JSON.stringify({
      type: "desktop-daemon-smoke-stopped",
      stopStatus,
    })}\n`,
  );

  app.exit(0);
  return true;
}

function waitForDesktopSmokeStopRequest(): Promise<void> {
  return new Promise((resolve) => {
    let buffer = "";
    const stop = () => {
      process.stdin.off("data", onData);
      resolve();
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.includes(DESKTOP_SMOKE_STOP_REQUEST)) {
        stop();
      }
    };

    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

async function bootstrap(): Promise<void> {
  if (!setupSingleInstanceLock()) {
    return;
  }

  await app.whenReady();

  const appDistDir = getAppDistDir();
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname, search, hash } = new URL(request.url);
    const decodedPath = decodeURIComponent(pathname);

    // Chromium can occasionally request the exported entrypoint directly.
    // Canonicalize it back to the route URL so Expo Router sees `/`, not `/index.html`.
    if (decodedPath.endsWith("/index.html")) {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalizedPath}${search}${hash}`, 307);
    }

    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }

    // SPA fallback: serve index.html for routes without a file extension
    if (!relativePath || !path.extname(relativePath)) {
      return net.fetch(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });

  applyAppIcon();
  setupApplicationMenu({
    onNewWindow: () => {
      void createWindow().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  if (await runDesktopSmokeIfRequested()) {
    return;
  }
  registerDaemonManager();
  registerWindowManager();
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();
  registerEditorTargetHandlers();

  // In-app "Open in new window": opens a window that lands on the given project
  // via the same open-project flow as a CLI launch (no move, no ownership).
  ipcMain.handle("paseo:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await createWindow({
      pendingOpenProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  // The first window of the session restores and persists saved geometry.
  await createWindow({ pendingOpenProjectPath, restoreWindowState: true });
  pendingOpenProjectPath = null;

  // Protocol + IPC handlers and the first window now exist: release any
  // second-instance launches that arrived during cold start.
  resolveBootstrapComplete();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow({ restoreWindowState: true });
    }
  });
}

void runDesktopStartup({
  hasPendingOpenProjectPath: Boolean(pendingOpenProjectPath),
  runCliPassthroughIfRequested,
  inheritLoginShellEnv,
  bootstrapGui: bootstrap,
  autoUpdateInstalledSkills: () => {
    void autoUpdateInstalledSkills().catch((error) => {
      log.error("[skills] auto-update failed", error);
    });
  },
}).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function showDaemonShutdownDialog(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("paseo:event:quitting", {});
  }
}

app.on(
  "before-quit",
  createBeforeQuitHandler({
    app,
    closeTransportSessions: closeAllTransportSessions,
    stopDesktopManagedDaemonIfNeeded: () =>
      stopDesktopManagedDaemonOnQuitIfNeeded({
        settingsStore: getDesktopSettingsStore(),
        isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
        stopDaemon: stopDesktopDaemonViaCli,
        showShutdownFeedback: showDaemonShutdownDialog,
      }),
    onStopError: (error) => {
      log.error("[desktop daemon] failed to stop managed daemon on quit", error);
    },
  }),
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
