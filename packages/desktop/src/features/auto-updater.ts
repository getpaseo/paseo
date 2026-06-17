import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { UUID } from "builder-util-runtime";
import { autoUpdater } from "electron-updater";
import {
  createAppUpdateService,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
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
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;

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

// AppImages have no install step. electron-updater "installs" by unlinking the
// running file and mv-ing the downloaded one into place; on app quit it does this
// via a *blocking* execFileSync(newAppImage, { APPIMAGE_EXIT_AFTER_INSTALL: "true" }).
// That env var is only honored by AppImageLauncher, so without it the freshly
// launched process boots the full app and never exits — the quit hangs forever,
// with the old binary already deleted. We therefore install AppImages only on
// explicit quitAndInstall (the "Update now" button), which takes the non-blocking
// spawn path. Every other target keeps auto-install-on-quit, which works there.
export function shouldAutoInstallOnQuit(input: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  return !(input.platform === "linux" && input.isAppImage);
}

class ElectronAppUpdateRuntime implements AppUpdateRuntime {
  private configured = false;

  configure(input: AppUpdateRuntimeConfiguration): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.autoInstallOnAppQuit = shouldAutoInstallOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    });
    autoUpdater.allowPrerelease = input.releaseChannel === "beta";
    autoUpdater.channel = input.releaseChannel === "beta" ? "beta" : "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await input.shouldAdmitUpdate(info as RuntimeUpdateInfo);
      } catch {
        return true;
      }
    };

    if (this.configured) return;
    this.configured = true;

    autoUpdater.on("update-available", (info) => {
      input.onUpdateAvailable(info as RuntimeUpdateInfo);
    });
    autoUpdater.on("update-downloaded", (info) => {
      input.onUpdateDownloaded(info as RuntimeUpdateInfo);
    });
    autoUpdater.on("update-not-available", () => {
      input.onUpdateNotAvailable();
    });
    autoUpdater.on("error", (error) => {
      input.onError(error);
    });
  }

  async checkForUpdates(): Promise<RuntimeUpdateCheckResult | null> {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return null;
    return {
      isUpdateAvailable: result.isUpdateAvailable,
      updateInfo: result.updateInfo as RuntimeUpdateInfo,
    };
  }

  downloadUpdate(): Promise<unknown> {
    return autoUpdater.downloadUpdate();
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
  }
}

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async () => bucketFromStagingUserId(await getStagingUserId()),
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
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}): Promise<AppUpdateCheckResult> {
  return appUpdateService.checkForAppUpdate({ currentVersion, releaseChannel, intent });
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
