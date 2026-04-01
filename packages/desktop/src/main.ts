import log from "electron-log/main";
log.initialize({ spyRendererConsole: true });

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { app, BrowserWindow, nativeImage, net, protocol } from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import {
  parseCliPassthroughArgsFromArgv,
  runCliPassthroughCommand,
} from "./daemon/runtime-paths.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  registerWindowManager,
  getMainWindowChromeOptions,
  getWindowBackgroundColor,
  resolveSystemWindowTheme,
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

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "paseo";
app.setName("Paseo");

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

function getWindowIconPath(): string | null {
  const candidates = app.isPackaged
    ? process.platform === "win32"
      ? [path.join(process.resourcesPath, "icon.ico"), path.join(process.resourcesPath, "icon.png")]
      : [path.join(process.resourcesPath, "icon.png")]
    : process.platform === "darwin"
      ? [path.resolve(__dirname, "../assets/icon.png")]
      : process.platform === "win32"
        ? [
            path.resolve(__dirname, "../assets/icon.ico"),
            path.resolve(__dirname, "../assets/icon.png"),
          ]
        : [path.resolve(__dirname, "../assets/icon.png")];

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

  const mainWindow = new BrowserWindow({
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
    },
  });

  setupWindowResizeEvents(mainWindow);
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    await mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app/`);
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

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  return true;
}

async function runCliPassthroughIfRequested(): Promise<boolean> {
  const cliArgs = parseCliPassthroughArgsFromArgv(process.argv);
  if (!cliArgs) {
    return false;
  }

  try {
    const exitCode = runCliPassthroughCommand(cliArgs);
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  return true;
}

async function bootstrap(): Promise<void> {
  if (await runCliPassthroughIfRequested()) {
    return;
  }

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
  registerDaemonManager();
  registerWindowManager();
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

app.on("before-quit", () => {
  closeAllTransportSessions();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
