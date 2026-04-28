import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

// Suppress harmless upstream Electron/Chromium/DevTools chatter.
const NOISE_PATTERNS = [
  /sandboxed_renderer\.bundle\.js script failed to run/i,
  /object null is not iterable \(cannot read property Symbol\(Symbol\.iterator\)\)/i,
  /Request Autofill\.(enable|setAddresses) failed/i,
  /simulcast_encoder_adapter\.cc.*StreamContext ctor parent is null/i,
  /stun_port\.cc.*Binding request timed out/i,
  /p2p\/base\/port\.cc.*Role Conflict/i,
  /Failed to resolve address for .*\.local\./i,
];
type WriteFnArg = { message?: { data?: unknown[] } };
type WriteFn = (opts: WriteFnArg) => void;
type Transport = { writeFn: WriteFn };
for (const t of [log.transports.console, log.transports.file] as unknown as Transport[]) {
  const original = t.writeFn;
  t.writeFn = (opts: WriteFnArg) => {
    const line = opts.message?.data?.map?.((d: unknown) => String(d)).join(" ") ?? "";
    if (NOISE_PATTERNS.some((re) => re.test(line))) return;
    original.call(t, opts);
  };
}

import { inheritLoginShellEnv } from "./login-shell-env.js";
inheritLoginShellEnv();

// Silence Electron's "Insecure Content-Security-Policy" / "unsafe-eval"
// dev-mode warnings — they spam the log on every webview load and
// Electron already gates them to non-packaged builds (so this is a
// no-op in production). Must be set before `app` initializes.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, net, protocol } from "electron";

// Enable Chrome DevTools Protocol so the Hubcode daemon can drive our
// <webview> panes with Playwright via `chromium.connectOverCDP`. The
// port is fixed (not 0/random) because the daemon runs in a separate
// process and has no easy way to ask us for the port mid-bootstrap —
// using a known port keeps the wiring trivial. Bound to 127.0.0.1 by
// Electron default, so remote machines can't attack it.
const HUBCODE_CDP_PORT = Number(process.env.HUBCODE_CDP_PORT ?? "9222");
app.commandLine.appendSwitch("remote-debugging-port", String(HUBCODE_CDP_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");
import {
  registerDaemonManager,
  restartDaemonIfDesktopManaged,
  broadcastClaudeCodeProgress,
} from "./daemon/daemon-manager.js";
import {
  ensureClaudeCode,
  getClaudeCodeStatus,
} from "./integrations/claude-code-binary.js";
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
import { registerBrowserViewIpc } from "./features/browser-views.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { registerOpenerHandlers } from "./features/opener.js";
import { setupApplicationMenu } from "./features/menu.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import { findDeepLinkInArgv, parseDeepLinkUrl, type DeepLink } from "./deep-link-routing.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";
const APP_SCHEME = "hubcode";
const OPEN_PROJECT_EVENT = "hubcode:event:open-project";
const DEEP_LINK_EVENT = "hubcode:event:deep-link";
app.setName("Hubcode");

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
    // Main checkout (e.g. "hubcode") gets default userData — only worktrees diverge.
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
      app.setPath("userData", path.join(app.getPath("appData"), `Hubcode-${devWorktreeName}`));
      log.info("[worktree] isolated userData for worktree:", devWorktreeName);
    } else {
      devWorktreeName = null;
    }
  } catch {
    devWorktreeName = null;
  }
}

// Expose real local IPs in WebRTC candidates instead of unresolvable mDNS
// hostnames (Electron's networking process can't resolve xxx.local.).
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

// Silence Chromium's native WebRTC stderr spam (simulcast encoder init,
// IPv6 STUN binding timeouts). These bypass electron-log's writeFn filter.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("vmodule", "*/webrtc/*=0,*/third_party/webrtc/*=0");

// Allow users to pass Chromium flags via HUBCODE_ELECTRON_FLAGS for debugging
// rendering issues (e.g. "--disable-gpu --ozone-platform=x11").
// Must run before app.whenReady().
const electronFlags = process.env.HUBCODE_ELECTRON_FLAGS?.trim();
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

// Hold the initial deep link (e.g. `hubcode://join-workspace/TOKEN`) until the
// renderer signals readiness via `hubcode:get-pending-deep-link`. Also updated
// by `second-instance` / `open-url` while the app is already running.
let pendingDeepLink: DeepLink | null = findDeepLinkInArgv(process.argv);

function sendDeepLinkEvent(win: BrowserWindow, link: DeepLink): void {
  win.webContents.send(DEEP_LINK_EVENT, link);
}

log.info("[open-project] argv:", process.argv);
log.info("[open-project] isDefaultApp:", process.defaultApp);
log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);

// The renderer pulls the pending path on mount via IPC — this avoids
// a race where the push event arrives before React registers its listener.
ipcMain.handle("hubcode:get-pending-open-project", () => {
  log.info("[open-project] renderer requested pending path:", pendingOpenProjectPath);
  const result = pendingOpenProjectPath;
  pendingOpenProjectPath = null;
  return result;
});

ipcMain.handle("hubcode:get-pending-deep-link", () => {
  log.info("[deep-link] renderer requested pending link:", pendingDeepLink);
  const result = pendingDeepLink;
  pendingDeepLink = null;
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

async function createMainWindow(): Promise<void> {
  const iconPath = getWindowIconPath();
  const systemTheme = resolveSystemWindowTheme();

  const title = devWorktreeName ? `Hubcode (${devWorktreeName})` : "Hubcode";
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
      // Dev-only: disable CORS so the Metro renderer (http://localhost:8081)
      // can hit a remote auth-server (e.g. auth.hubcode.ai) without that
      // origin being on the server's TRUSTED_ORIGINS allow-list. Packaged
      // builds load via the app:// scheme, which is whitelisted server-side,
      // so webSecurity stays on in production.
      ...(app.isPackaged ? {} : { webSecurity: false }),
    },
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
    // React DevTools Extension DISABLED — it's been generating
    // "Internal React error: Expected static flag was missing. Please
    // notify the React team." + "Uncaught TypeError: Oc is not a
    // function" whenever browser panes mount/unmount. Those `Oc` calls
    // come from React DevTools' minified internal hook instrumenter,
    // which isn't compatible with React 19's new static-flag model
    // when combined with rapid remounts. Re-enable via env var when
    // needed for a specific debug session.
    if (process.env.HUBCODE_ENABLE_REACT_DEVTOOLS === "true") {
      const { loadReactDevTools } = await import("./features/react-devtools.js");
      await loadReactDevTools();
    }
    await mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
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
    const deepLink = findDeepLinkInArgv(commandLine);
    log.info("[deep-link] second-instance deepLink:", deepLink);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
      if (openProjectPath) {
        sendOpenProjectEvent(win, openProjectPath);
      }
      if (deepLink) {
        sendDeepLinkEvent(win, deepLink);
      }
    } else if (deepLink) {
      pendingDeepLink = deepLink;
    }
  });

  // macOS delivers `hubcode://...` clicks via open-url instead of argv.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const parsed = parseDeepLinkUrl(url);
    if (!parsed) return;
    log.info("[deep-link] open-url:", url);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
      sendDeepLinkEvent(win, parsed);
    } else {
      pendingDeepLink = parsed;
    }
  });

  // Register the custom scheme with the OS so `hubcode://` links in external
  // apps (browsers, chat clients) launch Hubcode Desktop.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(APP_SCHEME, process.execPath, [
        path.resolve(process.argv[1] ?? ""),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(APP_SCHEME);
  }

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

  // Pin Chromium's color scheme so DevTools + every webContents keep
  // a consistent theme. Without this, a fresh `WebContentsView`
  // loading `about:blank` (which has no <meta color-scheme>) makes
  // Chromium think a light-mode context appeared, and Electron's
  // DevTools panel — which follows the theme of the most-recent
  // attached webContents — flips from dark to light. Mirror whatever
  // the OS was at launch; the app UI is dark-first so default to dark
  // if the system doesn't express a preference.
  nativeTheme.themeSource = nativeTheme.shouldUseDarkColors ? "dark" : "light";

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
  registerBrowserViewIpc();
  await createMainWindow();

  // Provision the bundled Claude Code runtime used by the Hubcode agent.
  // Best-effort and non-blocking — failures are logged but don't block app
  // boot, and the user can retry from Settings → Providers → Hubcode.
  //
  // Sequencing: the daemon may already be running (renderer can request
  // start_desktop_daemon during window load). If we install on a daemon
  // that started without HUBCODE_CLAUDE_BIN, the Hubcode provider stays
  // "Not installed" until the daemon restarts — so we restart it ourselves
  // once install completes, but only if (a) it was already running and
  // (b) this desktop instance owns it.
  void (async () => {
    try {
      const initial = await getClaudeCodeStatus();
      const result = await ensureClaudeCode({ onProgress: broadcastClaudeCodeProgress });
      if (!initial.installed && result.installed) {
        await restartDaemonIfDesktopManaged();
      }
    } catch (err) {
      log.warn("[main] background ensureClaudeCode() failed", err);
    }
  })();

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
