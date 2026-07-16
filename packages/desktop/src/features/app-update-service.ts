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
  errorMessage: string | null;
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
  installUpdateOnQuit(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  }): Promise<boolean>;
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
  errorMessage?: string | null;
}): AppUpdateCheckResult {
  const { currentVersion, hasUpdate, readyToInstall, info, errorMessage = null } = input;

  return {
    hasUpdate,
    readyToInstall,
    currentVersion,
    latestVersion: info?.version ?? currentVersion,
    body: typeof info?.releaseNotes === "string" ? info.releaseNotes : null,
    date: typeof info?.releaseDate === "string" ? info.releaseDate : null,
    errorMessage,
  };
}

async function performQuitAndInstall(
  runtime: AppUpdateRuntime,
  onBeforeQuit?: () => Promise<void>,
): Promise<void> {
  if (onBeforeQuit) await onBeforeQuit();
  runtime.quitAndInstall(/* isSilent */ false, /* isForceRunAfter */ true);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let cachedUpdateInfo: RuntimeUpdateInfo | null = null;
  let downloadedUpdateVersion: string | null = null;
  let configuredReleaseChannel: AppReleaseChannel | null = null;

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
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
        const alreadyReady = downloadedUpdateVersion === info.version;
        cachedUpdateInfo = info;
        downloadedUpdateVersion = alreadyReady ? info.version : null;
      },
      onUpdateDownloaded(info) {
        cachedUpdateInfo = info;
        downloadedUpdateVersion = info.version;
      },
      onUpdateNotAvailable() {
        clearUpdateState();
      },
      onError(error) {
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
        errorMessage: getErrorMessage(error),
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

    const check = await checkForAppUpdate({
      currentVersion,
      releaseChannel,
      intent: "manual",
    });
    if (!check.hasUpdate) {
      return {
        installed: false,
        version: currentVersion,
        message: check.errorMessage ?? "No update available.",
      };
    }

    return installCachedUpdate(currentVersion, onBeforeQuit);
  }

  async function installCachedUpdate(
    currentVersion: string,
    onBeforeQuit?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult> {
    if (!cachedUpdateInfo) {
      return {
        installed: false,
        version: currentVersion,
        message: "No update available. Check for updates first.",
      };
    }

    const readyVersion = cachedUpdateInfo.version;
    if (isReadyToInstallVersion(readyVersion)) {
      await performQuitAndInstall(deps.runtime, onBeforeQuit);
      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    }

    try {
      await deps.runtime.downloadUpdate();
      if (cachedUpdateInfo?.version !== readyVersion) {
        return {
          installed: false,
          version: currentVersion,
          message: "A newer update was found and will be installed later.",
        };
      }
      downloadedUpdateVersion = readyVersion;
      await performQuitAndInstall(deps.runtime, onBeforeQuit);

      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.reportInstallError?.(message);
      return {
        installed: false,
        version: currentVersion,
        message: `Update failed: ${message}`,
      };
    }
  }

  async function installUpdateOnQuit({
    currentVersion,
    releaseChannel,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  }): Promise<boolean> {
    if (!deps.isPackaged() || !downloadedUpdateVersion) {
      return false;
    }

    const check = await checkForAppUpdate({
      currentVersion,
      releaseChannel,
      intent: "automatic",
    });
    if (!check.hasUpdate) {
      return false;
    }

    const result = await installCachedUpdate(currentVersion);
    return result.installed;
  }

  return {
    checkForAppUpdate,
    downloadAndInstallUpdate,
    installUpdateOnQuit,
  };
}
