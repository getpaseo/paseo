import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";
inheritLoginShellEnv();

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, nativeImage, net, protocol } from "electron";
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
import { registerWorkspaceWindowManager } from "./window/workspace-window-manager.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { setupApplicationMenu } from "./features/menu.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { PendingOpenProjectStore } from "./pending-open-project-store.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "paseo";
const BASE_APP_NAME = "Paseo";

// In dev mode, detect git worktrees and isolate each instance so multiple
// Electron windows can run side-by-side (separate userData = separate lock).
let devWorktreeName: string | null = null;
if (!app.isPackaged) {
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

const configuredDevAppName = process.env.PASEO_DEV_APP_NAME?.trim();
const runtimeAppName =
  app.isPackaged || !configuredDevAppName
    ? !app.isPackaged && devWorktreeName
      ? `${BASE_APP_NAME} (${devWorktreeName})`
      : BASE_APP_NAME
    : configuredDevAppName;
app.setName(runtimeAppName);

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
const pendingOpenProjectStore = new PendingOpenProjectStore();

log.info("[open-project] argv:", process.argv);
log.info("[open-project] isDefaultApp:", process.defaultApp);
log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);

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

async function createMainWindow(options: {
  pendingOpenProjectPath?: string | null;
  initialPath?: string | null;
} = {}): Promise<BrowserWindow> {
  const iconPath = getWindowIconPath();
  const systemTheme = resolveSystemWindowTheme();

  const title = runtimeAppName;
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

  setupWindowResizeEvents(mainWindow);
  setupDefaultContextMenu(mainWindow);
  setupDragDropPrevention(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  if (!app.isPackaged) {
    const { loadReactDevTools } = await import("./features/react-devtools.js");
    await loadReactDevTools();
    await mainWindow.loadURL(new URL(options.initialPath ?? "/", `${DEV_SERVER_URL}/`).toString());
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return mainWindow;
  }

  const initialPath = options.initialPath?.trim() || "/";
  await mainWindow.loadURL(`${APP_SCHEME}://app${initialPath.startsWith("/") ? initialPath : `/${initialPath}`}`);
  return mainWindow;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

type OpenTrackedWindowFn = (options?: {
  pendingOpenProjectPath?: string | null;
  initialPath?: string | null;
}) => Promise<BrowserWindow>;

let openTrackedWindow: OpenTrackedWindowFn | null = null;

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
    void app
      .whenReady()
      .then(() => {
        if (!openTrackedWindow) {
          throw new Error("Tracked window opener not ready");
        }
        return openTrackedWindow({ pendingOpenProjectPath: openProjectPath });
      })
      .catch((error) => {
        log.error("[window] failed to create new window from second-instance", error);
      });
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
  if (!pendingOpenProjectPath && (await runCliPassthroughIfRequested())) {
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
  setupApplicationMenu({
    onNewWindow: () => {
      void (openTrackedWindow?.() ?? Promise.reject(new Error("Window manager not ready"))).catch(
        (error) => {
          log.error("[window] failed to create new window from menu", error);
        },
      );
    },
  });
  ensureNotificationCenterRegistration();
  registerDaemonManager();
  registerWindowManager();
  const workspaceWindowManager = registerWorkspaceWindowManager({
    createWindow: async (options) => {
      if (!openTrackedWindow) {
        throw new Error("Tracked window opener not ready");
      }
      return await openTrackedWindow(options);
    },
  });
  openTrackedWindow = async (options) => {
    const win = await createMainWindow(options);
    workspaceWindowManager.trackWindow(win);
    return win;
  };
  registerDialogHandlers();
  registerNotificationHandlers();
  registerOpenerHandlers();
  await openTrackedWindow({ pendingOpenProjectPath });
  pendingOpenProjectPath = null;

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!openTrackedWindow) {
        return;
      }
      await openTrackedWindow();
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
