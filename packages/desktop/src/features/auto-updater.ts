import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppUpdateCheckResult = {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string;
  latestVersion: string;
  body: string | null;
  date: string | null;
};

export type AppUpdateInstallResult = {
  installed: boolean;
  version: string | null;
  message: string;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cachedUpdateInfo: UpdateInfo | null = null;
let downloadedUpdateVersion: string | null = null;
let downloading = false;
let autoUpdaterConfigured = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function configureAutoUpdater(): void {
  // Download updates in the background and only prompt once they are ready to install.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Suppress built-in dialogs; the renderer handles UI.
  autoUpdater.autoRunAppAfterInstall = true;

  if (autoUpdaterConfigured) {
    return;
  }

  autoUpdaterConfigured = true;

  autoUpdater.on("update-available", (info) => {
    cachedUpdateInfo = info;
    downloadedUpdateVersion = null;
    downloading = true;
  });

  autoUpdater.on("update-downloaded", (info) => {
    cachedUpdateInfo = info;
    downloadedUpdateVersion = info.version;
    downloading = false;
  });

  autoUpdater.on("update-not-available", () => {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    downloading = false;
  });

  autoUpdater.on("error", (error) => {
    downloading = false;
    console.error("[auto-updater] Updater event failed:", error);
  });
}

function isReadyToInstallVersion(version: string): boolean {
  return downloadedUpdateVersion === version;
}

function buildCheckResult(input: {
  currentVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  info?: UpdateInfo | null;
}): AppUpdateCheckResult {
  const { currentVersion, hasUpdate, readyToInstall, info } = input;

  return {
    hasUpdate,
    readyToInstall,
    currentVersion,
    latestVersion: info?.version ?? currentVersion,
    body: typeof info?.releaseNotes === "string" ? info.releaseNotes : null,
    date: typeof info?.releaseDate === "string" ? info.releaseDate : null,
  };
}

function scheduleQuitAndInstall(onBeforeQuit?: () => Promise<void>): void {
  // Use a short delay to allow the renderer to receive the response.
  setTimeout(async () => {
    try {
      if (onBeforeQuit) await onBeforeQuit();
      autoUpdater.quitAndInstall(/* isSilent */ false, /* isForceRunAfter */ true);
    } catch (error) {
      console.error("[auto-updater] quitAndInstall failed:", error);
    }
  }, 1500);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkForAppUpdate(currentVersion: string): Promise<AppUpdateCheckResult> {
  if (!app.isPackaged) {
    return buildCheckResult({
      currentVersion,
      hasUpdate: false,
      readyToInstall: false,
    });
  }

  configureAutoUpdater();

  const cachedVersion = cachedUpdateInfo?.version ?? null;
  if (cachedVersion && cachedVersion !== currentVersion) {
    return buildCheckResult({
      currentVersion,
      hasUpdate: true,
      readyToInstall: isReadyToInstallVersion(cachedVersion),
      info: cachedUpdateInfo,
    });
  }

  try {
    const result = await autoUpdater.checkForUpdates();

    if (!result || !result.updateInfo) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    const info = result.updateInfo;
    const latestVersion = info.version;
    const hasUpdate = latestVersion !== currentVersion;

    if (hasUpdate) {
      cachedUpdateInfo = info;
      downloading = !isReadyToInstallVersion(latestVersion);
      return buildCheckResult({
        currentVersion,
        hasUpdate: true,
        readyToInstall: isReadyToInstallVersion(latestVersion),
        info,
      });
    }

    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    downloading = false;

    return buildCheckResult({
      currentVersion,
      hasUpdate: false,
      readyToInstall: false,
    });
  } catch (error) {
    console.error("[auto-updater] Failed to check for updates:", error);
    return buildCheckResult({
      currentVersion,
      hasUpdate: false,
      readyToInstall: false,
    });
  }
}

export async function downloadAndInstallUpdate(
  currentVersion: string,
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  if (!app.isPackaged) {
    return {
      installed: false,
      version: currentVersion,
      message: "Auto-update is not available in development mode.",
    };
  }

  if (!cachedUpdateInfo) {
    return {
      installed: false,
      version: currentVersion,
      message: "No update available. Check for updates first.",
    };
  }

  configureAutoUpdater();

  const readyVersion = cachedUpdateInfo.version;
  if (isReadyToInstallVersion(readyVersion)) {
    scheduleQuitAndInstall(onBeforeQuit);
    return {
      installed: true,
      version: readyVersion,
      message: "Update downloaded. The app will restart shortly.",
    };
  }

  if (downloading) {
    return {
      installed: false,
      version: currentVersion,
      message: "Update is still being prepared. Try again in a moment.",
    };
  }

  downloading = true;

  try {
    await autoUpdater.downloadUpdate();
    downloadedUpdateVersion = readyVersion;
    downloading = false;
    scheduleQuitAndInstall(onBeforeQuit);

    return {
      installed: true,
      version: readyVersion,
      message: "Update downloaded. The app will restart shortly.",
    };
  } catch (error) {
    downloading = false;
    const message = error instanceof Error ? error.message : String(error);
    console.error("[auto-updater] Failed to download/install update:", message);
    return {
      installed: false,
      version: currentVersion,
      message: `Update failed: ${message}`,
    };
  }
}
