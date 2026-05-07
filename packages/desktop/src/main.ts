process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, Menu, ipcMain, nativeImage, net, protocol, session } from "electron";
import { createDaemonCommandHandlers, registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
  setupDarwinPaintRefresh,
  setupWindowResizeEvents,
  setupDefaultContextMenu,
  setupDragDropPrevention,
} from "./window/window-manager.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContents,
  listRegisteredPaseoBrowserIds,
  registerPaseoBrowserWebContents,
  setWorkspaceActivePaseoBrowserId,
} from "./features/browser-webviews.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createBeforeQuitHandler,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { autoUpdateSkillsIfInstalled } from "./integrations/integrations-manager.js";
import { runDesktopStartup } from "./desktop-startup.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "paseo";
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";

function isAllowedBrowserWebviewUrl(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.href === "about:blank"
    );
  } catch {
    return false;
  }
}

function preventUnsafeBrowserWebviewNavigation(
  event: Electron.Event,
  url: string | undefined,
): void {
  if (!isAllowedBrowserWebviewUrl(url)) {
    event.preventDefault();
  }
}
const OPEN_PROJECT_EVENT = "paseo:event:open-project";
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
app.setName("Paseo");

function getBrowserIdFromWebviewPartition(partition: string | undefined): string | null {
  const prefix = "persist:paseo-browser-";
  if (!partition?.startsWith(prefix)) {
    return null;
  }
  const browserId = partition.slice(prefix.length).trim();
  return browserId.length > 0 ? browserId : null;
}

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
    { role: "copy", enabled: params.selectionText.length > 0 },
    { role: "paste" },
    { type: "separator" },
    { role: "selectAll" },
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
    }).trim();
    devWorktreeName = path.basename(topLevel);
    // Main checkout (e.g. "paseo") gets default userData — only worktrees diverge.
    const commonDir = path.resolve(
      topLevel,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: topLevel,
        encoding: "utf-8",
        timeout: 3000,
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

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("paseo:get-pending-open-project", () => {
  log.info("[open-project] renderer requested pending path:", pendingOpenProjectPath);
  const result = pendingOpenProjectPath;
  pendingOpenProjectPath = null;
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
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
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

async function createMainWindow(): Promise<void> {
  const iconPath = getWindowIconPath();
  const systemTheme = resolveSystemWindowTheme();

  const title = devWorktreeName ? `Paseo (${devWorktreeName})` : "Paseo";
  const mainWindow = new BrowserWindow({
    title,
    width: 1200,
    height: 800,
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

  if (devWorktreeName) {
    app.dock?.setBadge(devWorktreeName);
  }

  setupDarwinPaintRefresh(mainWindow);
  setupWindowResizeEvents(mainWindow);
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isAllowedBrowserWebviewUrl(params.src)) {
      event.preventDefault();
      return;
    }
    const browserId = getBrowserIdFromWebviewPartition(params.partition);
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
    contents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserWebviewUrl(url)) {
        return { action: "deny" };
      }
      contents.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    contents.on("context-menu", (_contextMenuEvent, params) => {
      showBrowserWebviewContextMenu(mainWindow, contents, params);
    });
    contents.on("will-navigate", (event) => {
      preventUnsafeBrowserWebviewNavigation(event, event.url);
    });
    contents.on("will-frame-navigate", (event) => {
      preventUnsafeBrowserWebviewNavigation(event, event.url);
    });
    contents.on("will-redirect", (event) => {
      preventUnsafeBrowserWebviewNavigation(event, event.url);
    });
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    await mainWindow.loadURL(DEV_SERVER_URL);
    return;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app/`);
}

function sendOpenProjectEvent(win: BrowserWindow, projectPath: string): void {
  const send = () => {
    log.info("[open-project] sending event to renderer:", projectPath);
    win.webContents.send(OPEN_PROJECT_EVENT, { path: projectPath });
  };

  if (win.webContents.isLoadingMainFrame()) {
    log.info("[open-project] waiting for did-finish-load before sending event");
    win.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function setupSingleInstanceLock(): boolean {
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
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
      if (openProjectPath) {
        sendOpenProjectEvent(win, openProjectPath);
      }
    }
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
  setupApplicationMenu();
  ensureNotificationCenterRegistration();
  if (await runDesktopSmokeIfRequested()) {
    return;
  }
  registerDaemonManager();
  registerWindowManager();
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();

  void autoUpdateSkillsIfInstalled().catch((error) => {
    log.warn("[integrations] auto-update skills failed", error);
  });

  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
}

void runDesktopStartup({
  hasPendingOpenProjectPath: Boolean(pendingOpenProjectPath),
  runCliPassthroughIfRequested,
  inheritLoginShellEnv,
  bootstrapGui: bootstrap,
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
