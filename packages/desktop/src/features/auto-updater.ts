import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, autoUpdater as electronAutoUpdater, BrowserWindow } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import {
  createAppUpdateService,
  type AppUpdateCheckResult,
  type AppUpdateDownloadProgress,
  type AppUpdateInstallLaunchResult,
  type AppUpdateInstallRequest,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type RuntimeDownloadProgressInfo,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service.js";
import {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateDownloadProgress,
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;

const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

interface AppUpdateLogSink {
  info(message: string, details: object): void;
}

interface AppUpdateCheckLogDetails {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}

interface AppUpdateCheckCompletedLogDetails extends AppUpdateCheckLogDetails {
  targetVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  errorMessage: string | null;
}

export function createAppUpdateLifecycleLogger(logger: AppUpdateLogSink) {
  return {
    checkStarted(details: AppUpdateCheckLogDetails): void {
      logger.info("[auto-updater] check started", details);
    },
    checkCompleted(details: AppUpdateCheckCompletedLogDetails): void {
      logger.info("[auto-updater] check completed", details);
    },
    updateAvailable(targetVersion: string): void {
      logger.info("[auto-updater] update available", { targetVersion });
    },
    updateDownloaded(targetVersion: string): void {
      logger.info("[auto-updater] update downloaded", { targetVersion });
    },
    downloadRequested(targetVersion: string): void {
      logger.info("[auto-updater] download requested", { targetVersion });
    },
    quitAndInstallRequested(details: AppUpdateInstallRequest): void {
      logger.info("[auto-updater] quitAndInstall requested", details);
    },
  };
}

const updateLifecycleLog = createAppUpdateLifecycleLogger(log);

function isUpdateChannelNotPublished(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UPDATE_CHANNEL_NOT_PUBLISHED_CODE
  );
}

export function shouldAdmitToRollout(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  return shouldAdmitAppUpdate({ ...args, intent: "automatic" });
}

export async function resolveStagingUserId(filePath: string): Promise<string> {
  try {
    const id = (await readFile(filePath, "utf8")).trim();
    if (UUID.check(id)) {
      return id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auto-updater] Couldn't read staging user ID, creating a blank one: ${error}`);
    }
  }

  const id = UUID.v5(randomBytes(4096), UUID.OID);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, id);
  } catch (error) {
    console.warn(`[auto-updater] Couldn't write out staging user ID: ${error}`);
  }

  return id;
}

export function getStagingUserId(): Promise<string> {
  if (cachedStagingUserIdPromise == null) {
    cachedStagingUserIdPromise = resolveStagingUserId(
      path.join(app.getPath("userData"), ".updaterId"),
    );
  }
  return cachedStagingUserIdPromise;
}

export function shouldInstallAppUpdateOnQuit(input: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  // AppImage's no-relaunch install path blocks while launching the replacement
  // binary, which can hang after the running file has already been replaced.
  return !(input.platform === "linux" && input.isAppImage);
}

const APP_UPDATE_DOWNLOAD_PROGRESS_EVENT = "paseo:event:app-update-download-progress";

function resolveProgressBarValue(progress: AppUpdateDownloadProgress | null): number {
  if (progress === null) return -1;
  if (!Number.isFinite(progress.percent)) return 0;
  return Math.max(0, Math.min(1, progress.percent / 100));
}

function broadcastDownloadProgress(progress: AppUpdateDownloadProgress | null): void {
  const normalizedBar = resolveProgressBarValue(progress);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setProgressBar(normalizedBar);
    } catch {
      // Progress bar support is optional across desktop environments.
    }
    try {
      win.webContents.send(APP_UPDATE_DOWNLOAD_PROGRESS_EVENT, progress);
    } catch {
      // Window may be tearing down during quitAndInstall.
    }
  }
}

export const MACOS_INSTALL_HANDOFF_TIMEOUT_MS = 2 * 60 * 1000;

export interface QuitAndInstallEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

function formatLaunchError(error: unknown): string {
  return error instanceof Error && typeof error.message === "string"
    ? error.message
    : String(error);
}

export function runElectronQuitAndInstall({
  platform,
  updater,
  nativeUpdater,
  isSilent,
  isForceRunAfter,
  timeoutMs = MACOS_INSTALL_HANDOFF_TIMEOUT_MS,
}: {
  platform: NodeJS.Platform;
  updater: QuitAndInstallEventSource & {
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  };
  nativeUpdater?: QuitAndInstallEventSource;
  isSilent: boolean;
  isForceRunAfter: boolean;
  timeoutMs?: number;
}): Promise<AppUpdateInstallLaunchResult> {
  // Only await macOS Squirrel preparation for explicit Download / Restart Now
  // installs (isForceRunAfter === true). Quit-time installs (isForceRunAfter === false)
  // return immediately so quit-lifecycle owns its separate handoff deadline.
  if (platform !== "darwin" || !isForceRunAfter || typeof nativeUpdater?.on !== "function") {
    let launchError: unknown = null;
    const captureLaunchError = (error: unknown) => {
      launchError ??= error;
    };
    updater.on("error", captureLaunchError);
    try {
      updater.quitAndInstall(isSilent, isForceRunAfter);
    } catch (error) {
      launchError ??= error;
    } finally {
      updater.removeListener?.("error", captureLaunchError);
    }
    if (launchError !== null) {
      return Promise.resolve({ started: false, errorMessage: formatLaunchError(launchError) });
    }
    return Promise.resolve({ started: true });
  }

  // With autoInstallOnAppQuit disabled, electron-updater's MacUpdater starts
  // native Squirrel preparation asynchronously inside quitAndInstall(). Keep
  // the explicit install promise pending until Squirrel hands off to quit, fails,
  // or hits the safety timeout.
  return new Promise<AppUpdateInstallLaunchResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      updater.removeListener?.("error", handleError);
      nativeUpdater.removeListener?.("error", handleError);
      nativeUpdater.removeListener?.("update-not-available", handleNotAvailable);
      nativeUpdater.removeListener?.("before-quit-for-update", handleQuitStarted);
    };
    const finish = (result: AppUpdateInstallLaunchResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleError = (error: unknown) => {
      finish({ started: false, errorMessage: formatLaunchError(error) });
    };
    const handleNotAvailable = () => {
      finish({ started: false, errorMessage: "Update could not be prepared for installation." });
    };
    const handleQuitStarted = () => {
      finish({ started: true });
    };

    timer = setTimeout(() => {
      finish({
        started: false,
        errorMessage: "Timed out waiting for the update installer to start.",
      });
    }, timeoutMs);

    updater.on("error", handleError);
    nativeUpdater.on("error", handleError);
    nativeUpdater.on("update-not-available", handleNotAvailable);
    nativeUpdater.on("before-quit-for-update", handleQuitStarted);

    try {
      updater.quitAndInstall(isSilent, isForceRunAfter);
    } catch (error) {
      handleError(error);
    }
  });
}

class ElectronAppUpdateRuntime implements AppUpdateRuntime {
  private configured = false;
  private configuration: AppUpdateRuntimeConfiguration | null = null;

  configure(input: AppUpdateRuntimeConfiguration): void {
    this.configuration = input;
    autoUpdater.autoDownload = input.autoDownload;
    autoUpdater.autoRunAppAfterInstall = true;
    // Paseo revalidates the current manifest before explicitly installing on quit.
    // Electron's built-in handler would install an older download without checking
    // whether a newer release has superseded it.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = input.releaseChannel === "beta";
    autoUpdater.channel = input.releaseChannel === "beta" ? "beta" : "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await (this.configuration?.shouldAdmitUpdate(info as RuntimeUpdateInfo) ?? true);
      } catch {
        return true;
      }
    };

    if (this.configured) return;
    this.configured = true;

    // electron-updater logs every emitted error before consumers can classify it.
    // Paseo reports genuine check, runtime, and install failures through the
    // callbacks below, so leave internal error logging disabled to avoid both
    // duplicate logs and expected missing-channel noise.
    const updaterLogger = autoUpdater.logger;
    autoUpdater.logger = {
      debug: updaterLogger?.debug ? (message) => updaterLogger.debug?.(message) : undefined,
      error: () => undefined,
      info: (message) => updaterLogger?.info(message),
      warn: (message) => updaterLogger?.warn(message),
    };

    autoUpdater.on("update-available", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateAvailable(updateInfo.version);
      this.configuration?.onUpdateAvailable(updateInfo);
    });
    autoUpdater.on("download-progress", (progress) => {
      this.configuration?.onDownloadProgress(progress as RuntimeDownloadProgressInfo);
    });
    autoUpdater.on("update-downloaded", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateDownloaded(updateInfo.version);
      this.configuration?.onUpdateDownloaded(updateInfo);
    });
    autoUpdater.on("error", (error) => {
      if (isUpdateChannelNotPublished(error)) return;
      this.configuration?.onError(error);
    });
  }

  setAutoDownload(enabled: boolean): void {
    autoUpdater.autoDownload = enabled;
  }

  async checkForUpdates(): Promise<RuntimeUpdateCheckResult | null> {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: result.updateInfo as RuntimeUpdateInfo,
      };
    } catch (error) {
      if (isUpdateChannelNotPublished(error)) return null;
      throw error;
    }
  }

  downloadUpdate(targetVersion: string): Promise<unknown> {
    updateLifecycleLog.downloadRequested(targetVersion);
    return autoUpdater.downloadUpdate();
  }

  quitAndInstall({
    targetVersion,
    isSilent,
    isForceRunAfter,
  }: AppUpdateInstallRequest): Promise<AppUpdateInstallLaunchResult> {
    broadcastDownloadProgress(null);
    autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
    updateLifecycleLog.quitAndInstallRequested({
      targetVersion,
      isSilent,
      isForceRunAfter,
    });
    return runElectronQuitAndInstall({
      platform: process.platform,
      updater: autoUpdater,
      nativeUpdater: electronAutoUpdater,
      isSilent,
      isForceRunAfter,
    });
  }
}

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async () => bucketFromStagingUserId(await getStagingUserId()),
  updateMode: async () => (await getDesktopSettingsStore().get()).updates.mode,
  onDownloadProgress: broadcastDownloadProgress,
  reportSettingsError: (error) => {
    console.warn(
      "[auto-updater] Failed to read desktop update mode, defaulting to automatic:",
      error,
    );
  },
  reportCheckError: (error) => {
    console.error("[auto-updater] Failed to check for updates:", error);
  },
  reportRuntimeError: (error) => {
    console.error("[auto-updater] Updater event failed:", error);
  },
  reportInstallError: (message) => {
    console.error("[auto-updater] Failed to download/install update:", message);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
  autoDownload,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
  autoDownload?: boolean;
}): Promise<AppUpdateCheckResult> {
  updateLifecycleLog.checkStarted({ currentVersion, releaseChannel, intent });
  const result = await appUpdateService.checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent,
    autoDownload,
  });
  updateLifecycleLog.checkCompleted({
    currentVersion,
    targetVersion: result.latestVersion,
    releaseChannel,
    intent,
    hasUpdate: result.hasUpdate,
    readyToInstall: result.readyToInstall,
    errorMessage: result.errorMessage,
  });
  return result;
}

export async function downloadAndInstallUpdate(
  {
    currentVersion,
    releaseChannel,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  },
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  return appUpdateService.downloadAndInstallUpdate(
    { currentVersion, releaseChannel },
    onBeforeQuit,
  );
}

export async function installAppUpdateOnQuit({
  currentVersion,
  releaseChannel,
  signal,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
}): Promise<boolean> {
  if (
    !shouldInstallAppUpdateOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    })
  ) {
    return false;
  }

  return appUpdateService.installUpdateOnQuit({ currentVersion, releaseChannel, signal });
}
