import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { UUID } from "builder-util-runtime";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string;
  latestVersion: string;
  body: string | null;
  date: string | null;
}

export interface AppUpdateInstallResult {
  installed: boolean;
  version: string | null;
  message: string;
}

export type AppReleaseChannel = "stable" | "beta";

export const rolloutManifestSchema = z.object({
  rolloutHours: z
    .union([z.number(), z.string().transform(Number)])
    .pipe(z.number().finite().nonnegative())
    .optional()
    .catch(undefined),
  releaseDate: z.string().optional().catch(undefined),
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cachedUpdateInfo: UpdateInfo | null = null;
let downloadedUpdateVersion: string | null = null;
let downloading = false;
let autoUpdaterConfigured = false;
let configuredReleaseChannel: AppReleaseChannel | null = null;
let cachedStagingUserIdPromise: Promise<string> | null = null;

export function shouldAdmitToRollout(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  if (args.channel !== "stable") return true;
  if (args.rolloutHours == null) return true;
  if (args.rolloutHours === 0) return true;
  if (!args.releaseDate) return true;

  const releaseTime = new Date(args.releaseDate).getTime();
  if (Number.isNaN(releaseTime)) return true;

  const ageHours = (args.now - releaseTime) / 3_600_000;
  if (ageHours < 0) return false;

  const pct = Math.min(100, (ageHours / args.rolloutHours) * 100);
  return args.bucket * 100 < pct;
}

export function bucketFromStagingUserId(stagingUserId: string): number {
  return UUID.parse(stagingUserId).readUInt32BE(12) / 0x100000000;
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function configureAutoUpdater(releaseChannel: AppReleaseChannel): void {
  // Download updates in the background and only prompt once they are ready to install.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Suppress built-in dialogs; the renderer handles UI.
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = releaseChannel === "beta";
  autoUpdater.channel = releaseChannel === "beta" ? "beta" : "latest";
  autoUpdater.allowDowngrade = false;
  autoUpdater.isUserWithinRollout = async (info) => {
    try {
      const parsed = rolloutManifestSchema.parse(info);
      const stagingUserId = await getStagingUserId();

      return shouldAdmitToRollout({
        channel: releaseChannel,
        rolloutHours: parsed.rolloutHours,
        releaseDate: parsed.releaseDate,
        now: Date.now(),
        bucket: bucketFromStagingUserId(stagingUserId),
      });
    } catch {
      return true;
    }
  };

  if (configuredReleaseChannel !== releaseChannel) {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    downloading = false;
    configuredReleaseChannel = releaseChannel;
  }

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

async function performQuitAndInstall(onBeforeQuit?: () => Promise<void>): Promise<void> {
  if (onBeforeQuit) await onBeforeQuit();
  autoUpdater.quitAndInstall(/* isSilent */ false, /* isForceRunAfter */ true);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
}): Promise<AppUpdateCheckResult> {
  if (!app.isPackaged) {
    return buildCheckResult({
      currentVersion,
      hasUpdate: false,
      readyToInstall: false,
    });
  }

  configureAutoUpdater(releaseChannel);

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
  {
    currentVersion,
    releaseChannel,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  },
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

  configureAutoUpdater(releaseChannel);

  const readyVersion = cachedUpdateInfo.version;
  if (isReadyToInstallVersion(readyVersion)) {
    await performQuitAndInstall(onBeforeQuit);
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
    await performQuitAndInstall(onBeforeQuit);

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
