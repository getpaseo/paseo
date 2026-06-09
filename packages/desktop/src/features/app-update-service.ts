import {
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

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

export interface RuntimeUpdateInfo {
  version: string;
  releaseNotes?: unknown;
  releaseDate?: unknown;
  rolloutHours?: unknown;
}

export interface RuntimeUpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: RuntimeUpdateInfo;
}

export interface AppUpdateRuntimeConfiguration {
  releaseChannel: AppReleaseChannel;
  shouldAdmitUpdate(info: RuntimeUpdateInfo): boolean | Promise<boolean>;
  onUpdateAvailable(info: RuntimeUpdateInfo): void;
  onUpdateDownloaded(info: RuntimeUpdateInfo): void;
  onUpdateNotAvailable(): void;
  onError(error: unknown): void;
}

export interface AppUpdateRuntime {
  configure(input: AppUpdateRuntimeConfiguration): void;
  checkForUpdates(): Promise<RuntimeUpdateCheckResult | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface AppUpdateService {
  checkForAppUpdate(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
  }): Promise<AppUpdateCheckResult>;
  downloadAndInstallUpdate(
    input: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
    },
    onBeforeQuit?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult>;
}

export interface AppUpdateServiceDeps {
  runtime: AppUpdateRuntime;
  isPackaged(): boolean;
  now(): number;
  bucket(): Promise<number>;
  reportCheckError?(error: unknown): void;
  reportRuntimeError?(error: unknown): void;
  reportInstallError?(message: string): void;
}

function buildCheckResult(input: {
  currentVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  info?: RuntimeUpdateInfo | null;
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

async function performQuitAndInstall(
  runtime: AppUpdateRuntime,
  onBeforeQuit?: () => Promise<void>,
): Promise<void> {
  if (onBeforeQuit) await onBeforeQuit();
  runtime.quitAndInstall(/* isSilent */ false, /* isForceRunAfter */ true);
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let cachedUpdateInfo: RuntimeUpdateInfo | null = null;
  let downloadedUpdateVersion: string | null = null;
  let downloading = false;
  let configuredReleaseChannel: AppReleaseChannel | null = null;

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    downloading = false;
  }

  function configureRuntime(releaseChannel: AppReleaseChannel, intent: AppUpdateCheckIntent): void {
    if (configuredReleaseChannel !== releaseChannel) {
      clearUpdateState();
      configuredReleaseChannel = releaseChannel;
    }

    deps.runtime.configure({
      releaseChannel,
      shouldAdmitUpdate: async (info) => {
        const parsed = rolloutManifestSchema.parse(info);
        return shouldAdmitAppUpdate({
          channel: releaseChannel,
          intent,
          rolloutHours: parsed.rolloutHours,
          releaseDate: parsed.releaseDate,
          now: deps.now(),
          bucket: await deps.bucket(),
        });
      },
      onUpdateAvailable(info) {
        cachedUpdateInfo = info;
        downloadedUpdateVersion = null;
        downloading = true;
      },
      onUpdateDownloaded(info) {
        cachedUpdateInfo = info;
        downloadedUpdateVersion = info.version;
        downloading = false;
      },
      onUpdateNotAvailable() {
        clearUpdateState();
      },
      onError(error) {
        downloading = false;
        deps.reportRuntimeError?.(error);
      },
    });
  }

  async function checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
  }): Promise<AppUpdateCheckResult> {
    if (!deps.isPackaged()) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    configureRuntime(releaseChannel, intent);

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
      const result = await deps.runtime.checkForUpdates();
      if (!result || !result.updateInfo || !result.isUpdateAvailable) {
        clearUpdateState();
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

      clearUpdateState();
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    } catch (error) {
      deps.reportCheckError?.(error);
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }
  }

  async function downloadAndInstallUpdate(
    {
      currentVersion,
      releaseChannel,
    }: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
    },
    onBeforeQuit?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult> {
    if (!deps.isPackaged()) {
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

    configureRuntime(releaseChannel, "manual");

    const readyVersion = cachedUpdateInfo.version;
    if (isReadyToInstallVersion(readyVersion)) {
      await performQuitAndInstall(deps.runtime, onBeforeQuit);
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
      await deps.runtime.downloadUpdate();
      downloadedUpdateVersion = readyVersion;
      downloading = false;
      await performQuitAndInstall(deps.runtime, onBeforeQuit);

      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    } catch (error) {
      downloading = false;
      const message = error instanceof Error ? error.message : String(error);
      deps.reportInstallError?.(message);
      return {
        installed: false,
        version: currentVersion,
        message: `Update failed: ${message}`,
      };
    }
  }

  return {
    checkForAppUpdate,
    downloadAndInstallUpdate,
  };
}
