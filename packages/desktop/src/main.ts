process.emitWarning = (() => {}) as typeof process.emitWarning;

import log from "electron-log/main";
log.transports.console.level = "info";
log.initialize({ spyRendererConsole: true });

import { inheritLoginShellEnv } from "./login-shell-env.js";

import path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  Menu,
  ipcMain,
  nativeImage,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { registerDaemonManager } from "./daemon/daemon-manager.js";
import { parsePassthroughCliArgsFromArgv, runPassthroughCli } from "./daemon/cli/passthrough.js";
import { closeAllTransportSessions } from "./daemon/local-transport.js";
import {
  applyDesktopWindowChromeMode,
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
import { resolveDesktopWindowChromeMode, windowChromeModeArgument } from "./window/chrome.js";
import { registerDialogHandlers } from "./features/dialogs.js";
import {
  registerNotificationHandlers,
  ensureNotificationCenterRegistration,
} from "./features/notifications.js";
import { createExternalUrlOpener } from "./features/opener.js";
import { createBrowserCaptureService } from "./features/browser-capture.js";
import { BrowserTunnelHost } from "./features/browser-tunnel.js";
import {
  fromElectronCookie,
  importBrowserProfile,
  readImportCookiesIntoSession,
  toElectronCookie,
} from "./features/browser-cookie-import.js";
import {
  BrowserBackupError,
  decryptBrowserBackup,
  encryptBrowserBackup,
  readBrowserSessionCookies,
  writeBrowserSessionCookies,
} from "./features/browser-backup.js";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { listBrowserImportSources } from "@getpaseo/server/browser-import";
import { registerEditorTargetHandlers } from "./features/editor-targets/ipc.js";
import { resolveAppIconPath } from "./features/stamped-icon.js";
import { setupApplicationMenu } from "./features/menu.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWebviewRegistry,
  listRegisteredPaseoBrowserIds,
  isPaseoBrowserWebviewAttach,
  preparePaseoBrowserWebContents,
  PendingBrowserWindowOpenRequests,
  registerBrowserWebviewNavigationGuards,
  unregisterPaseoBrowserFromHost,
  registerAttachedPaseoBrowser,
  setWorkspaceActivePaseoBrowserId,
  unregisterPaseoBrowserHost,
} from "./features/browser-webviews/index.js";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  PASEO_BROWSER_PROFILE_PARTITION,
  getPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  readLegacyPaseoBrowserIds,
} from "./features/browser-profile.js";
import { parseOpenProjectPathFromArgv } from "./open-project-routing.js";
import {
  createDesktopWindowOwner,
  type DesktopWindowOwner,
  type OwnedDesktopWindow,
} from "./window/desktop-window-owner.js";
import { getDesktopSettingsStore } from "./settings/desktop-settings-electron.js";
import { clampWindowStateToWorkAreas, createWindowStateStore } from "./settings/window-state.js";
import {
  isDesktopManagedDaemonRunningSync,
  stopDesktopDaemonViaCli,
} from "./daemon/daemon-manager.js";
import {
  createQuitLifecycle,
  registerExternalQuitSignals,
  stopDesktopManagedDaemonOnQuitIfNeeded,
} from "./daemon/quit-lifecycle.js";
import { runDesktopStartup } from "./desktop-startup.js";
import { registerBrowserAutomationIpc } from "./features/browser-automation/ipc.js";
import {
  BrowserPasswords,
  registerBrowserPasswordsIpc,
} from "./features/browser-passwords/index.js";
import { PasswordVault, type PasswordCrypto } from "./features/browser-passwords/vault.js";
import { BrowserKeyboard } from "./features/browser-keyboard/index.js";
import { installAppUpdateOnQuit } from "./features/auto-updater.js";
import {
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  type AgentDeepLinkTarget,
} from "@getpaseo/protocol/agent-deep-link";
import { AgentNavigationInbox, parseAgentDeepLinkFromArgv } from "./agent-navigation.js";

const DEV_SERVER_URL = process.env.EXPO_DEV_URL ?? "http://localhost:8081";

const APP_SCHEME = "paseo";
const APP_SCHEME_ALIASES = [APP_SCHEME, "pandaos"] as const;
const PASEO_DEBUG = process.env.PASEO_DEBUG === "1";
const DISABLE_SINGLE_INSTANCE_LOCK = process.env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK === "1";
const APP_NAME = process.env.PASEO_TEST_APP_NAME?.trim() || "PandaOS";
const DESKTOP_WINDOW_CHROME_MODE = resolveDesktopWindowChromeMode({
  platform: process.platform,
  override: process.env.PASEO_DESKTOP_WINDOW_CONTROLS,
  isPackaged: app.isPackaged,
});
const UPDATE_QUIT_DEADLINE_MS = 5_000;
const pendingBrowserWindowOpenRequests = new PendingBrowserWindowOpenRequests();
const agentNavigationInbox = new AgentNavigationInbox();

let resolveBootstrapComplete: () => void;
const bootstrapComplete = new Promise<void>((resolve) => {
  resolveBootstrapComplete = resolve;
});
let bootstrapIsComplete = false;

app.setName(APP_NAME);
log.info("[desktop] app startup", {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
});

interface AttachedBrowserInput {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

function readAttachedBrowserInput(input: unknown): AttachedBrowserInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.browserId !== "string" || record.browserId.trim().length === 0) {
    return null;
  }
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  if (
    typeof record.webContentsId !== "number" ||
    !Number.isInteger(record.webContentsId) ||
    record.webContentsId <= 0
  ) {
    return null;
  }
  return {
    browserId: record.browserId.trim(),
    workspaceId: record.workspaceId.trim(),
    webContentsId: record.webContentsId,
  };
}

function readActiveBrowserInput(
  input: unknown,
): { workspaceId: string; browserId: string | null } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || record.workspaceId.trim().length === 0) {
    return null;
  }
  const browserId = typeof record.browserId === "string" ? record.browserId.trim() : null;
  return { workspaceId: record.workspaceId.trim(), browserId: browserId || null };
}

const browserKeyboard = new BrowserKeyboard(getPaseoBrowserWebviewRegistry());
browserKeyboard.registerIpc();

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

function getBrowserPopupWindowOptions(
  mainWindow: BrowserWindow,
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: mainWindow,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PASEO_BROWSER_PROFILE_PARTITION,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };
}

function installBrowserWindowOpenHandler(input: {
  contents: Electron.WebContents;
  sourceContents: Electron.WebContents;
  mainWindow: BrowserWindow;
}): void {
  const { contents, sourceContents, mainWindow } = input;

  contents.setWindowOpenHandler(({ url, disposition, frameName, features, postBody }) => {
    const decision = decideBrowserWindowOpenRequest({
      url,
      disposition,
      frameName,
      features,
      hasPostBody: postBody !== undefined && postBody !== null,
    });

    if (decision.kind === "deny") {
      return { action: "deny" };
    }
    if (decision.kind === "popup") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: getBrowserPopupWindowOptions(mainWindow),
      };
    }

    const sourceBrowserId = getPaseoBrowserIdForWebContents(sourceContents);
    if (sourceBrowserId) {
      mainWindow.webContents.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
        sourceBrowserId,
        url: decision.url,
      });
    } else {
      pendingBrowserWindowOpenRequests.add(sourceContents.id, decision.url);
    }
    return { action: "deny" };
  });

  contents.on("did-create-window", (popupWindow) => {
    const popupContents = popupWindow.webContents;
    registerBrowserWebviewNavigationGuards(popupContents);
    popupContents.on("context-menu", (_event, params) => {
      showBrowserWebviewContextMenu(popupWindow, popupContents, params);
    });
    installBrowserWindowOpenHandler({
      contents: popupContents,
      sourceContents,
      mainWindow,
    });
  });
}

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

const electronFlags = process.env.PASEO_ELECTRON_FLAGS?.trim();
if (electronFlags) {
  for (const token of electronFlags.split(/\s+/)) {
    const [key, ...rest] = token.replace(/^--/, "").split("=");
    app.commandLine.appendSwitch(key, rest.join("=") || undefined);
  }
  log.info("[electron-flags]", electronFlags);
}

if (process.platform === "linux") {
  app.setDesktopName("PandaOS.desktop");
  if (!app.commandLine.hasSwitch("class")) app.commandLine.appendSwitch("class", "PandaOS");
  log.info("[linux-sandbox]", {
    enabled: !app.commandLine.hasSwitch("no-sandbox"),
    reason: process.env.PASEO_DESKTOP_SANDBOX_REASON ?? "Chromium default",
  });
}

let pendingOpenProjectPath = parseOpenProjectPathFromArgv({
  argv: process.argv,
  isDefaultApp: process.defaultApp,
});
let pendingAgentNavigation = parseAgentDeepLinkFromArgv(process.argv);

let desktopWindowOwner: DesktopWindowOwner<AgentDeepLinkTarget>;

if (PASEO_DEBUG) {
  log.info("[open-project] argv:", process.argv);
  log.info("[open-project] isDefaultApp:", process.defaultApp);
  log.info("[open-project] pendingOpenProjectPath:", pendingOpenProjectPath);
}

ipcMain.handle("paseo:get-pending-open-project", (event) => {
  const webContentsId = event.sender.id;
  const result = desktopWindowOwner.takePendingProject(webContentsId);
  log.info("[open-project] renderer requested pending path:", {
    webContentsId,
    pendingPath: result,
  });
  return result;
});

ipcMain.handle("paseo:agent-navigation:ready", (event) => {
  return agentNavigationInbox.windowReady(event.sender.id);
});

const browserTunnelHosts = new Map<number, BrowserTunnelHost>();

function browserTunnelFor(sender: Electron.WebContents): BrowserTunnelHost {
  if (BrowserWindow.fromWebContents(sender)?.webContents !== sender) {
    throw new Error("Browser tunnels require an application window");
  }
  let host = browserTunnelHosts.get(sender.id);
  if (!host) {
    host = new BrowserTunnelHost((event) => {
      if (!sender.isDestroyed()) sender.send("paseo:browser:tunnel:socket", event);
    });
    browserTunnelHosts.set(sender.id, host);
    const ownedHost = host;
    sender.once("destroyed", () => {
      browserTunnelHosts.delete(sender.id);
      void ownedHost.dispose().catch((error) => log.warn("Browser tunnel cleanup failed", error));
    });
  }
  return host;
}

for (const operation of ["start", "stop", "close", "resume"] as const) {
  ipcMain.handle(`paseo:browser:tunnel:${operation}`, (event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid tunnel identifier");
    return browserTunnelFor(event.sender)[operation](id);
  });
}
ipcMain.handle("paseo:browser:tunnel:write", (event, id: unknown, data: unknown) => {
  if (typeof id !== "string" || typeof data !== "string") throw new Error("Invalid tunnel write");
  return browserTunnelFor(event.sender).write(id, data);
});

ipcMain.handle("paseo:browser:register-attached", (event, rawInput: unknown) => {
  const input = readAttachedBrowserInput(rawInput);
  if (!input) {
    throw new Error("Invalid attached browser registration");
  }
  const registered = registerAttachedPaseoBrowser({
    ...input,
    sender: event.sender,
    profileSession: getPaseoBrowserProfileSession(session),
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) {
    throw new Error("Attached browser registration was rejected");
  }
  const guest = webContents.fromId(input.webContentsId);
  if (!guest) {
    throw new Error("Attached browser guest disappeared after registration");
  }
  browserKeyboard.attach({ contents: guest, hostContents: event.sender });
  log.info("[browser-webview] registered", {
    browserId: input.browserId,
    webContentsId: input.webContentsId,
    registeredBrowserIds: listRegisteredPaseoBrowserIds(),
  });
  for (const url of pendingBrowserWindowOpenRequests.take(input.webContentsId)) {
    event.sender.send(BROWSER_NEW_TAB_REQUEST_EVENT, {
      sourceBrowserId: input.browserId,
      url,
    });
  }
});

ipcMain.handle("paseo:browser:unregister-workspace-browser", async (event, browserId: unknown) => {
  if (typeof browserId === "string" && browserId.trim().length > 0) {
    const normalizedBrowserId = browserId.trim();
    const hasOtherHost = getPaseoBrowserWebviewRegistry().hasBrowserInOtherHostWindow(
      event.sender.id,
      normalizedBrowserId,
    );
    unregisterPaseoBrowserFromHost(event.sender.id, normalizedBrowserId);
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    const legacyProfile = hasOtherHost
      ? null
      : getLegacyPaseoBrowserProfileSession(session, normalizedBrowserId);
    if (legacyProfile) {
      try {
        await clearPaseoBrowserProfile({
          profileSessions: [legacyProfile],
          listGuests: () => [],
          logReloadError: () => {},
        });
      } catch (error) {
        log.warn("[browser-profile] failed to clear legacy tab profile", {
          browserId: normalizedBrowserId,
          error,
        });
      }
    }
  }
});

ipcMain.handle("paseo:browser:set-workspace-active-browser", (event, rawInput: unknown) => {
  const input = readActiveBrowserInput(rawInput);
  if (input) {
    setWorkspaceActivePaseoBrowserId({ ...input, hostWebContentsId: event.sender.id });
  }
});

ipcMain.handle("paseo:browser:focus", (event, browserId: unknown): boolean => {
  if (typeof browserId !== "string" || browserId.trim().length === 0) {
    return false;
  }
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
  if (!contents) {
    return false;
  }
  contents.focus();
  return true;
});

ipcMain.handle("paseo:browser:open-devtools", (event, browserId: unknown) => {
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
  const contents = getPaseoBrowserWebContentsForHostWindow(browserId, event.sender.id);
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

ipcMain.handle("paseo:browser:clear-profile", async (_event, rawLegacyBrowserIds: unknown) => {
  const profileSessions = getPaseoBrowserProfileSessions(
    session,
    readLegacyPaseoBrowserIds(rawLegacyBrowserIds),
  );
  const profileSession = profileSessions[0];
  await clearPaseoBrowserProfile({
    profileSessions,
    listGuests: () =>
      listPaseoBrowserProfileGuests({
        profileSession,
        webContents: webContents.getAllWebContents(),
      }),
    logReloadError: (webContentsId, error) => {
      log.warn("[browser-profile] failed to reload guest", { webContentsId, error });
    },
  });
  await rm(browserSessionFile, { force: true });
  browserSessionRestoreFailed = false;
  browserSessionError = null;
});

function assertBrowserSettingsSender(event: Electron.IpcMainInvokeEvent): void {
  const host = BrowserWindow.fromWebContents(event.sender);
  if (
    !host ||
    event.sender.session === session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("Browser settings are only available to PandaOS windows.");
  }
}

const browserCrypto: PasswordCrypto = {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (cipherText) => safeStorage.decryptString(cipherText),
};
const browserPasswordVault = new PasswordVault({
  filePath: path.join(app.getPath("userData"), "browser-passwords.json"),
  crypto: browserCrypto,
});
const browserSessionFile = path.join(app.getPath("userData"), "browser-session.enc");
let browserSessionError: string | null = null;
let browserSessionRestoreFailed = false;
let browserSessionWrites = Promise.resolve();
function saveBrowserSession(): Promise<void> {
  browserSessionWrites = browserSessionWrites
    .catch(() => undefined)
    .then(async () => {
      if (browserSessionRestoreFailed)
        throw new Error(
          "The previous session could not be unlocked; its encrypted file was preserved.",
        );
      const profile = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
      const cookies = (await profile.cookies.get({}))
        .map(fromElectronCookie)
        .filter((cookie) => cookie.expires === -1);
      await writeBrowserSessionCookies(browserSessionFile, cookies, browserCrypto);
      await profile.cookies.flushStore();
      profile.flushStorageData();
      browserSessionError = null;
      return undefined;
    });
  return browserSessionWrites;
}

ipcMain.handle("paseo:browser:profile-status", (event) => {
  assertBrowserSettingsSender(event);
  return { available: browserCrypto.isAvailable(), error: browserSessionError };
});
ipcMain.handle("paseo:browser:list-import-sources", (event) => {
  assertBrowserSettingsSender(event);
  return listBrowserImportSources();
});

ipcMain.handle("paseo:browser:read-import-cookies", (event, sourceId: unknown) => {
  assertBrowserSettingsSender(event);
  return readImportCookiesIntoSession({
    sourceId,
    cookies: session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION).cookies,
  });
});

ipcMain.handle("paseo:browser:read-import-profile", async (event, raw: unknown) => {
  assertBrowserSettingsSender(event);
  const input = localImportSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "Invalid browser import request." };
  try {
    const { readBrowserImportCookies, readBrowserImportPasswords, BrowserImportError } =
      await import("@getpaseo/server/browser-import");
    try {
      return {
        ok: true,
        cookies: await readBrowserImportCookies(input.data.sourceId),
        logins: await readBrowserImportPasswords(
          input.data.sourceId,
          undefined,
          input.data.primaryPassword,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof BrowserImportError
            ? error.message
            : "Could not read the browser profile. Unlock its original keyring and retry.",
      };
    }
  } catch {
    return { ok: false, error: "Browser profile import is unavailable." };
  }
});

ipcMain.handle("paseo:browser:backup-file", async (event, raw: unknown) => {
  assertBrowserSettingsSender(event);
  const input = z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("save"), encrypted: z.string().max(32 * 1024 * 1024) }).strict(),
      z.object({ action: z.literal("read") }).strict(),
    ])
    .safeParse(raw);
  if (!input.success) return { ok: false, error: "Invalid backup file request." };
  try {
    if (input.data.action === "read") {
      const selected = await dialog.showOpenDialog({
        title: "Restore host browser backup",
        properties: ["openFile"],
      });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, cancelled: true };
      const file = selected.filePaths[0];
      if ((await stat(file)).size > 32 * 1024 * 1024)
        return { ok: false, error: "Browser backup is too large." };
      return { ok: true, encrypted: await readFile(file, "utf8") };
    }
    const selected = await dialog.showSaveDialog({
      title: "Save host browser backup",
      defaultPath: "pandaos-host-browser-backup.json",
    });
    if (selected.canceled || !selected.filePath) return { ok: true, cancelled: true };
    const temporary = `${selected.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, input.data.encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporary, selected.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not open or save the encrypted backup file." };
  }
});

const localImportSchema = z
  .object({ sourceId: z.string().min(1).max(2048), primaryPassword: z.string().max(1024) })
  .strict();
ipcMain.handle("paseo:browser:import-profile", async (event, raw: unknown) => {
  assertBrowserSettingsSender(event);
  const input = localImportSchema.safeParse(raw);
  if (!input.success) return { ok: false, error: "Invalid browser import request." };
  try {
    const result = await importBrowserProfile({
      ...input.data,
      cookies: session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION).cookies,
      vault: browserPasswordVault,
    });
    await saveBrowserSession();
    return { ok: true, ...result };
  } catch (error) {
    const { BrowserImportError } = await import("@getpaseo/server/browser-import");
    return {
      ok: false,
      error:
        error instanceof BrowserImportError
          ? error.message
          : "Browser import failed. Unlock the system keychain and retry; existing saved passwords were preserved.",
    };
  }
});

let browserBackupBusy = false;
ipcMain.handle("paseo:browser:backup", async (event, raw: unknown) => {
  assertBrowserSettingsSender(event);
  const input = z
    .object({ action: z.enum(["export", "restore"]), passphrase: z.string().min(12).max(1024) })
    .strict()
    .safeParse(raw);
  if (!input.success)
    return { ok: false, error: "Use a backup passphrase with 12–1024 characters." };
  if (browserBackupBusy)
    return { ok: false, error: "A browser backup operation is already running." };
  browserBackupBusy = true;
  try {
    const profile = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
    if (!browserCrypto.isAvailable())
      throw new BrowserBackupError(
        "Unlock the system keychain before backing up or restoring browser logins.",
      );
    if (input.data.action === "export") {
      const selected = await dialog.showSaveDialog({
        title: "Save encrypted browser backup",
        defaultPath: "pandaos-browser-backup.json",
        filters: [{ name: "Encrypted browser backup", extensions: ["json"] }],
      });
      if (selected.canceled || !selected.filePath) return { ok: true, cancelled: true };
      const cookies = (await profile.cookies.get({})).map(fromElectronCookie);
      const logins = browserPasswordVault.exportLogins();
      const encrypted = await encryptBrowserBackup(
        { version: 1, cookies, logins },
        input.data.passphrase,
      );
      const temporary = `${selected.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporary, selected.filePath);
      } finally {
        await rm(temporary, { force: true });
      }
      return {
        ok: true,
        cookieCount: cookies.length,
        passwordCount: logins.length,
        skippedCookies: 0,
        skippedPasswords: 0,
      };
    }
    const selected = await dialog.showOpenDialog({
      title: "Restore encrypted browser backup",
      properties: ["openFile"],
      filters: [{ name: "Encrypted browser backup", extensions: ["json"] }],
    });
    const file = selected.filePaths[0];
    if (selected.canceled || !file) return { ok: true, cancelled: true };
    if ((await stat(file)).size > 32 * 1024 * 1024)
      throw new BrowserBackupError("Browser backup is too large.");
    const data = await decryptBrowserBackup(await readFile(file, "utf8"), input.data.passphrase);
    const cookieKey = (cookie: { domain: string; path: string; name: string }) =>
      JSON.stringify([cookie.domain, cookie.path, cookie.name]);
    const existing = new Set(
      (await profile.cookies.get({})).map(fromElectronCookie).map(cookieKey),
    );
    const added = [];
    try {
      for (const cookie of data.cookies) {
        if (
          existing.has(cookieKey(cookie)) ||
          (cookie.expires !== -1 && cookie.expires <= Date.now() / 1000)
        )
          continue;
        await profile.cookies.set(toElectronCookie(cookie));
        existing.add(cookieKey(cookie));
        added.push(cookie);
      }
      const result = browserPasswordVault.importLogins(data.logins);
      await saveBrowserSession();
      return {
        ok: true,
        cookieCount: added.length,
        skippedCookies: data.cookies.length - added.length,
        ...result,
      };
    } catch {
      for (const cookie of added)
        await profile.cookies.remove(toElectronCookie(cookie).url, cookie.name);
      throw new BrowserBackupError(
        "Restore could not finish. Existing logins were preserved; some new passwords may already have been restored. Unlock the system keychain and retry.",
      );
    }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof BrowserBackupError
          ? error.message
          : "Browser backup failed. Existing profile data was preserved; unlock the system keychain and retry.",
    };
  } finally {
    browserBackupBusy = false;
  }
});

const browserCapture = createBrowserCaptureService<Electron.NativeImage>({
  findGuest: getPaseoBrowserWebContentsForHostWindow,
  decodeImage: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
  clipboard: {
    write: async ({ text, image }) => {
      const items: Record<string, string | Blob> = {};
      if (text) items["text/plain"] = text;
      if (image) {
        const png = image.toPNG();
        const bytes = new Uint8Array(png.byteLength);
        bytes.set(png);
        items["image/png"] = new Blob([bytes], { type: "image/png" });
      }
      await clipboard.write([new ClipboardItem(items)]);
    },
  },
  warn: (event, details) => log.warn(`[browser-capture] ${event}`, details),
});

ipcMain.handle("paseo:browser:capture-element", (event, browserId: unknown, rect: unknown) =>
  browserCapture.capture({ browserId, hostWebContentsId: event.sender.id, rect }),
);

ipcMain.handle("paseo:browser:copy-element", (_event, payload: unknown) =>
  browserCapture.copy(payload),
);

registerBrowserPasswordsIpc(
  ipcMain,
  new BrowserPasswords({
    vault: browserPasswordVault,
    registry: getPaseoBrowserWebviewRegistry(),
    isHostSender: (sender) => {
      const contents = webContents.fromId(sender.id);
      return (
        contents !== undefined &&
        contents.getType() === "window" &&
        contents.session !== getPaseoBrowserProfileSession(session)
      );
    },
    randomId: randomUUID,
    now: Date.now,
    warn: (event, details) => log.warn(`[browser-passwords] ${event}`, details),
  }),
);

protocol.registerSchemesAsPrivileged(
  APP_SCHEME_ALIASES.map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  })),
);

function getPreloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function getBrowserKeyboardPreloadPath(): string {
  return path.join(__dirname, "features", "browser-keyboard", "guest-preload.js");
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
      path.resolve(__dirname, "../assets/icon-dev.png"),
      path.resolve(__dirname, "../assets/icon.ico"),
      path.resolve(__dirname, "../assets/icon.png"),
    ];
  }
  return [
    path.resolve(__dirname, "../assets/icon-dev.png"),
    path.resolve(__dirname, "../assets/icon.png"),
  ];
}

function getWindowIconPath(): string | null {
  const candidates = getWindowIconCandidates();
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getDevBuildLabel(): string | null {
  if (app.isPackaged) {
    return null;
  }
  return process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;
}

let cachedEffectiveIconPath: string | null = null;

async function getEffectiveAppIconPath(): Promise<string | null> {
  if (cachedEffectiveIconPath !== null) {
    return cachedEffectiveIconPath;
  }
  const baseIconPath = getWindowIconPath();
  if (app.isPackaged || !baseIconPath) {
    cachedEffectiveIconPath = baseIconPath;
    return baseIconPath;
  }
  const devLabel = getDevBuildLabel();
  cachedEffectiveIconPath = await resolveAppIconPath({
    isPackaged: false,
    baseIconPath,
    devLabel,
    cacheDir: app.getPath("userData"),
  });
  return cachedEffectiveIconPath;
}

async function applyAppIcon(): Promise<void> {
  if (app.isPackaged || process.platform !== "darwin") {
    return;
  }

  const iconPath = await getEffectiveAppIconPath();
  if (!iconPath) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
}

function getWorkAreasPrimaryFirst(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id);
  return [primary, ...others].map((display) => display.workArea);
}

async function createWindow(
  options: {
    initialRoute?: string | null;
    restoreWindowState?: boolean;
    onCreated?: (webContentsId: number) => void;
    onClosed?: (webContentsId: number) => void;
  } = {},
): Promise<BrowserWindow> {
  const iconPath = await getEffectiveAppIconPath();
  const systemTheme = resolveSystemWindowTheme();

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
      mode: DESKTOP_WINDOW_CHROME_MODE,
    }),
    webPreferences: {
      preload: getPreloadPath(),
      additionalArguments: [windowChromeModeArgument(DESKTOP_WINDOW_CHROME_MODE)],
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  applyDesktopWindowChromeMode({ win: mainWindow, mode: DESKTOP_WINDOW_CHROME_MODE });

  const webContentsId = mainWindow.webContents.id;
  options.onCreated?.(webContentsId);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame && !isSameDocument) {
      agentNavigationInbox.windowLoading(webContentsId);
    }
  });
  mainWindow.on("closed", () => {
    options.onClosed?.(webContentsId);
    agentNavigationInbox.removeWindow(webContentsId);
    unregisterPaseoBrowserHost(webContentsId);
    browserKeyboard.detachHost(webContentsId);
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
    if (!isPaseoBrowserWebviewAttach(params)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;

    webPreferences.nodeIntegrationInSubFrames = true;
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
    webPreferences.preload = getBrowserKeyboardPreloadPath();
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    preparePaseoBrowserWebContents(contents);
    contents.once("destroyed", () => {
      pendingBrowserWindowOpenRequests.delete(contents.id);
    });
    installBrowserWindowOpenHandler({
      contents,
      sourceContents: contents,
      mainWindow,
    });
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
    const initialUrl = options.initialRoute
      ? new URL(options.initialRoute, `${DEV_SERVER_URL}/`).toString()
      : DEV_SERVER_URL;
    await mainWindow.loadURL(initialUrl);
    return mainWindow;
  }

  await mainWindow.loadURL(`${APP_SCHEME}://app${options.initialRoute ?? "/"}`);
  return mainWindow;
}

function ownedDesktopWindow(win: BrowserWindow): OwnedDesktopWindow<AgentDeepLinkTarget> {
  return {
    webContentsId: win.webContents.id,
    isDestroyed: () => win.isDestroyed(),
    isVisible: () => win.isVisible(),
    isMinimized: () => win.isMinimized(),
    restore: () => win.restore(),
    show: () => win.show(),
    focus: () => win.focus(),
    sendAgent: (target) => win.webContents.send("paseo:event:open-agent", target),
  };
}

desktopWindowOwner = createDesktopWindowOwner<AgentDeepLinkTarget>({
  async create(input) {
    const win = await createWindow({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: input.onCreated,
      onClosed: input.onClosed,
    });
    return ownedDesktopWindow(win);
  },
  windows: () => BrowserWindow.getAllWindows().map(ownedDesktopWindow),
  focusedWindow: () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    return ownedDesktopWindow(win);
  },
  agentRoute: buildAgentDeepLinkRoute,
  deliverAgent: (webContentsId, target) =>
    agentNavigationInbox.deliverOrQueue(webContentsId, target),
});

function receiveAgentDeepLink(input: string): void {
  const target = parseAgentDeepLink(input);
  if (!target) {
    return;
  }

  if (bootstrapIsComplete) {
    void desktopWindowOwner
      .openOrFocusAgent(target)
      .catch((error) => log.error("[window] failed to route agent link", error));
    return;
  }

  pendingAgentNavigation = target;
  void bootstrapComplete.then(() => {
    if (pendingAgentNavigation !== target) {
      return undefined;
    }
    pendingAgentNavigation = null;
    void desktopWindowOwner
      .openOrFocusAgent(target)
      .catch((error) => log.error("[window] failed to route queued agent link", error));
    return undefined;
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveAgentDeepLink(url);
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
    const agentTarget = parseAgentDeepLinkFromArgv(commandLine);
    if (agentTarget) {
      void bootstrapComplete
        .then(() => desktopWindowOwner.openOrFocusAgent(agentTarget))
        .catch((error) => log.error("[window] failed to route second-instance agent link", error));
      return;
    }

    log.info("[open-project] second-instance commandLine:", commandLine);
    const openProjectPath = parseOpenProjectPathFromArgv({
      argv: commandLine,
      isDefaultApp: false,
    });
    log.info("[open-project] second-instance openProjectPath:", openProjectPath);

    void bootstrapComplete
      .then(() => desktopWindowOwner.openAdditional({ pendingProjectPath: openProjectPath }))
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

async function bootstrap(): Promise<void> {
  if (!setupSingleInstanceLock()) {
    return;
  }

  await app.whenReady();
  const profileSession = session.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
  try {
    const restored = await readBrowserSessionCookies(browserSessionFile, browserCrypto);
    const existing = await profileSession.cookies.get({});
    for (const cookie of restored) {
      if (
        existing.some(
          (current) =>
            current.name === cookie.name &&
            current.domain === cookie.domain &&
            current.path === cookie.path,
        )
      )
        continue;
      await profileSession.cookies.set(toElectronCookie(cookie));
    }
  } catch {
    browserSessionRestoreFailed = true;
    browserSessionError =
      "Browser session logins could not be restored. Unlock the system keychain, then restart PandaOS. Existing browser data was preserved.";
  }
  let cookieSaveTimer: ReturnType<typeof setTimeout> | null = null;
  profileSession.cookies.on("changed", () => {
    if (cookieSaveTimer) clearTimeout(cookieSaveTimer);
    cookieSaveTimer = setTimeout(() => {
      cookieSaveTimer = null;
      void saveBrowserSession().catch(() => {
        browserSessionError =
          "Session logins could not be saved. Unlock the system keychain before restarting PandaOS.";
      });
    }, 250);
  });

  const appDistDir = getAppDistDir();
  const handleAppProtocol = (request: Request) => {
    const { pathname, search, hash } = new URL(request.url);
    const decodedPath = decodeURIComponent(pathname);

    if (decodedPath.endsWith("/index.html")) {
      const normalizedPath = decodedPath.slice(0, -"/index.html".length) || "/";
      return Response.redirect(`${APP_SCHEME}://app${normalizedPath}${search}${hash}`, 307);
    }

    const filePath = path.join(appDistDir, decodedPath);
    const relativePath = path.relative(appDistDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Not found", { status: 404 });
    }

    if (!relativePath || !path.extname(relativePath)) {
      return net.fetch(pathToFileURL(path.join(appDistDir, "index.html")).toString());
    }

    return net.fetch(pathToFileURL(filePath).toString());
  };
  for (const scheme of APP_SCHEME_ALIASES) {
    protocol.handle(scheme, handleAppProtocol);
  }

  await applyAppIcon();
  setupApplicationMenu({
    onNewWindow: () => {
      void desktopWindowOwner.openAdditional().catch((error) => {
        log.error("[window] failed to create window from menu", error);
      });
    },
  });
  ensureNotificationCenterRegistration();
  registerDaemonManager();
  registerWindowManager({ mode: DESKTOP_WINDOW_CHROME_MODE });
  registerDialogHandlers();
  registerNotificationHandlers();
  const openExternalUrl = createExternalUrlOpener({ open: shell.openExternal });
  ipcMain.handle("paseo:opener:openUrl", (_event, value: unknown) => openExternalUrl(value));
  registerEditorTargetHandlers();
  registerBrowserAutomationIpc();

  ipcMain.handle("paseo:window:openNew", async (_event, options?: unknown) => {
    const pendingPath =
      options && typeof options === "object" && "pendingOpenProjectPath" in options
        ? (options as { pendingOpenProjectPath?: unknown }).pendingOpenProjectPath
        : null;
    await desktopWindowOwner.openAdditional({
      pendingProjectPath: typeof pendingPath === "string" ? pendingPath : null,
    });
  });

  const initialAgentNavigation = pendingAgentNavigation;
  pendingAgentNavigation = null;
  await desktopWindowOwner.openPrimary({
    initialRoute: initialAgentNavigation ? buildAgentDeepLinkRoute(initialAgentNavigation) : null,
    pendingProjectPath: pendingOpenProjectPath,
  });
  pendingOpenProjectPath = null;

  bootstrapIsComplete = true;
  resolveBootstrapComplete();

  if (pendingAgentNavigation) {
    const target = pendingAgentNavigation;
    pendingAgentNavigation = null;
    await desktopWindowOwner.openOrFocusAgent(target);
  }

  app.on("activate", () => {
    void desktopWindowOwner.restoreWhenActivated().catch((error) => {
      console.error("Failed to restore a desktop window after activation", error);
    });
  });
}

void runDesktopStartup({
  hasPendingGuiLaunchRequest: Boolean(pendingOpenProjectPath || pendingAgentNavigation),
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

const quitLifecycle = createQuitLifecycle({
  app,
  closeTransportSessions: closeAllTransportSessions,
  stopDesktopManagedDaemonIfNeeded: async () => {
    await saveBrowserSession().catch(() => {
      log.warn("[browser-profile] session checkpoint failed; unlock the system keychain");
    });
    return stopDesktopManagedDaemonOnQuitIfNeeded({
      settingsStore: getDesktopSettingsStore(),
      isDesktopManagedDaemonRunning: isDesktopManagedDaemonRunningSync,
      stopDaemon: () => stopDesktopDaemonViaCli("quit"),
      showShutdownFeedback: showDaemonShutdownDialog,
    });
  },
  installAppUpdateOnQuit: async (signal) => {
    const settings = await getDesktopSettingsStore().get();
    return installAppUpdateOnQuit({
      currentVersion: app.getVersion(),
      releaseChannel: settings.releaseChannel,
      signal,
    });
  },
  createUpdateDeadlineSignal: () => AbortSignal.timeout(UPDATE_QUIT_DEADLINE_MS),
  onStopError: (error) => {
    log.error("[desktop daemon] failed to stop managed daemon on quit", error);
  },
  onUpdateError: (error) => {
    log.error("[auto-updater] failed to validate downloaded update on quit", error);
  },
});

electronAutoUpdater.on("before-quit-for-update", () => {
  log.info("[auto-updater] before-quit-for-update", { currentVersion: app.getVersion() });
  quitLifecycle.handleBeforeQuitForUpdate();
});
app.on("before-quit", quitLifecycle.handleBeforeQuit);
registerExternalQuitSignals({ signals: process, quit: () => app.quit() });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
