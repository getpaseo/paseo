import type { DesktopUpdateMode } from "../settings/desktop-settings.js";
import {
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export interface AppUpdateDownloadProgress {
  version: string | null;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  downloading: boolean;
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
  errorMessage?: string | null;
}

export interface RuntimeUpdateInfo {
  version: string;
  releaseNotes?: unknown;
  releaseDate?: unknown;
  rolloutHours?: unknown;
}

export interface RuntimeDownloadProgressInfo {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface RuntimeUpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: RuntimeUpdateInfo;
}

export interface AppUpdateRuntimeConfiguration {
  releaseChannel: AppReleaseChannel;
  autoDownload: boolean;
  shouldAdmitUpdate(info: RuntimeUpdateInfo): boolean | Promise<boolean>;
  onUpdateAvailable(info: RuntimeUpdateInfo): void;
  onDownloadProgress(progress: RuntimeDownloadProgressInfo): void;
  onUpdateDownloaded(info: RuntimeUpdateInfo): void;
  onError(error: unknown): void;
}

export interface AppUpdateInstallRequest {
  targetVersion: string;
  isSilent: boolean;
  isForceRunAfter: boolean;
}

export interface AppUpdateInstallLaunchResult {
  started: boolean;
  errorMessage?: string;
}

export interface AppUpdateRuntime {
  configure(input: AppUpdateRuntimeConfiguration): void;
  setAutoDownload?(enabled: boolean): void;
  checkForUpdates(): Promise<RuntimeUpdateCheckResult | null>;
  downloadUpdate(targetVersion: string): Promise<unknown>;
  quitAndInstall(
    input: AppUpdateInstallRequest,
  ): Promise<AppUpdateInstallLaunchResult> | AppUpdateInstallLaunchResult;
}

export interface AppUpdateService {
  checkForAppUpdate(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
    autoDownload?: boolean;
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
    signal: AbortSignal;
  }): Promise<boolean>;
}

export interface AppUpdateServiceDeps {
  runtime: AppUpdateRuntime;
  isPackaged(): boolean;
  now(): number;
  bucket(): Promise<number>;
  updateMode?: () => DesktopUpdateMode | Promise<DesktopUpdateMode>;
  onDownloadProgress?(progress: AppUpdateDownloadProgress | null): void;
  reportSettingsError?(error: unknown): void;
  reportCheckError?(error: unknown): void;
  reportRuntimeError?(error: unknown): void;
  reportInstallError?(message: string): void;
}

function buildCheckResult(input: {
  currentVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  downloading?: boolean;
  info?: RuntimeUpdateInfo | null;
  errorMessage?: string | null;
}): AppUpdateCheckResult {
  const {
    currentVersion,
    hasUpdate,
    readyToInstall,
    downloading = false,
    info,
    errorMessage = null,
  } = input;

  return {
    hasUpdate,
    readyToInstall,
    downloading,
    currentVersion,
    latestVersion: info?.version ?? currentVersion,
    body: typeof info?.releaseNotes === "string" ? info.releaseNotes : null,
    date: typeof info?.releaseDate === "string" ? info.releaseDate : null,
    errorMessage,
  };
}

async function performQuitAndInstall(
  runtime: AppUpdateRuntime,
  {
    targetVersion,
    onBeforeQuit,
    restart,
  }: {
    targetVersion: string;
    onBeforeQuit?: () => Promise<void>;
    restart: boolean;
  },
): Promise<void> {
  if (onBeforeQuit) await onBeforeQuit();
  const launch = await runtime.quitAndInstall({
    targetVersion,
    isSilent: !restart,
    isForceRunAfter: restart,
  });
  if (!launch.started) {
    throw new Error(launch.errorMessage ?? "Failed to launch update installer.");
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function buildDeferredInstallResult(currentVersion: string): AppUpdateInstallResult {
  return {
    installed: false,
    version: currentVersion,
    message: "Update validation timed out. The update will be installed later.",
  };
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let cachedUpdateInfo: RuntimeUpdateInfo | null = null;
  let downloadedUpdateVersion: string | null = null;
  let configuredReleaseChannel: AppReleaseChannel | null = null;
  let preparationError: { version: string; message: string } | null = null;
  let preparingUpdateVersion: string | null = null;
  let currentAutoDownload = true;
  let checkQueue: Promise<void> = Promise.resolve();

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    preparationError = null;
    preparingUpdateVersion = null;
    deps.onDownloadProgress?.(null);
  }

  function buildPreviouslyAdmittedUpdateResult(
    currentVersion: string,
    checkedInfo: RuntimeUpdateInfo,
  ): AppUpdateCheckResult | null {
    const info = cachedUpdateInfo;
    if (!info || info.version === currentVersion || info.version !== checkedInfo.version) {
      return null;
    }

    const readyToInstall = isReadyToInstallVersion(info.version);
    return buildCheckResult({
      currentVersion,
      hasUpdate: true,
      readyToInstall,
      downloading: !readyToInstall && preparingUpdateVersion === info.version,
      info,
      errorMessage: preparationError?.version === info.version ? preparationError.message : null,
    });
  }

  async function resolveUpdateMode(): Promise<DesktopUpdateMode> {
    if (!deps.updateMode) {
      return "automatic";
    }
    try {
      return await deps.updateMode();
    } catch (error) {
      deps.reportSettingsError?.(error);
      return "automatic";
    }
  }

  function resolveAutoDownload(mode: DesktopUpdateMode, override: boolean | undefined): boolean {
    return override ?? mode === "automatic";
  }

  function configureRuntime(
    releaseChannel: AppReleaseChannel,
    intent: AppUpdateCheckIntent,
    initialAutoDownload: boolean,
    autoDownloadOverride: boolean | undefined,
  ): void {
    if (configuredReleaseChannel !== releaseChannel) {
      clearUpdateState();
      configuredReleaseChannel = releaseChannel;
    }
    currentAutoDownload = initialAutoDownload;

    deps.runtime.configure({
      releaseChannel,
      autoDownload: initialAutoDownload,
      shouldAdmitUpdate: async (info) => {
        const parsed = rolloutManifestSchema.parse(info);
        const bucket = await deps.bucket();
        const liveMode = await resolveUpdateMode();
        if (intent === "automatic" && liveMode === "off") {
          return false;
        }
        const admitted = shouldAdmitAppUpdate({
          channel: releaseChannel,
          intent,
          rolloutHours: parsed.rolloutHours,
          releaseDate: parsed.releaseDate,
          now: deps.now(),
          bucket,
        });
        if (admitted) {
          currentAutoDownload = resolveAutoDownload(liveMode, autoDownloadOverride);
          deps.runtime.setAutoDownload?.(currentAutoDownload);
        }
        return admitted;
      },
      onUpdateAvailable(info) {
        const alreadyReady = downloadedUpdateVersion === info.version;
        cachedUpdateInfo = info;
        downloadedUpdateVersion = alreadyReady ? info.version : null;
        if (!alreadyReady && currentAutoDownload && preparingUpdateVersion === null) {
          preparingUpdateVersion = info.version;
        }
      },
      onDownloadProgress(progress) {
        const percent = Number.isFinite(progress.percent)
          ? Math.max(0, Math.min(100, progress.percent))
          : 0;
        deps.onDownloadProgress?.({
          version: preparingUpdateVersion ?? cachedUpdateInfo?.version ?? null,
          percent,
          transferred: Number.isFinite(progress.transferred) ? progress.transferred : 0,
          total: Number.isFinite(progress.total) ? progress.total : 0,
          bytesPerSecond: Number.isFinite(progress.bytesPerSecond) ? progress.bytesPerSecond : 0,
        });
      },
      onUpdateDownloaded(info) {
        // A superseded download can finish after a newer manifest check. Keep
        // the validated manifest as the install target in that case.
        cachedUpdateInfo ??= info;
        downloadedUpdateVersion = info.version;
        if (preparingUpdateVersion === info.version) {
          preparingUpdateVersion = null;
        }
        if (preparationError?.version === info.version) {
          preparationError = null;
        }
        deps.onDownloadProgress?.(null);
      },
      onError(error) {
        if (preparingUpdateVersion) {
          preparationError = {
            version: preparingUpdateVersion,
            message: getErrorMessage(error),
          };
          preparingUpdateVersion = null;
        }
        deps.onDownloadProgress?.(null);
        deps.reportRuntimeError?.(error);
      },
    });
  }

  function runCheckExclusively<T>(check: () => Promise<T>): Promise<T> {
    const result = checkQueue.then(check, check);
    checkQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function resolveAvailableUpdateResult(
    currentVersion: string,
    info: RuntimeUpdateInfo,
  ): AppUpdateCheckResult {
    const latestVersion = info.version;
    if (latestVersion === currentVersion) {
      clearUpdateState();
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    cachedUpdateInfo = info;
    const readyToInstall = isReadyToInstallVersion(latestVersion);
    const errorMessage =
      preparationError?.version === latestVersion ? preparationError.message : null;
    if (!errorMessage) {
      preparationError = null;
    }
    if (
      !readyToInstall &&
      !errorMessage &&
      currentAutoDownload &&
      preparingUpdateVersion === null
    ) {
      preparingUpdateVersion = latestVersion;
    }
    return buildCheckResult({
      currentVersion,
      hasUpdate: true,
      readyToInstall,
      downloading:
        !readyToInstall &&
        !errorMessage &&
        (currentAutoDownload || preparingUpdateVersion === latestVersion),
      info,
      errorMessage,
    });
  }

  async function checkForAppUpdate({
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
    if (!deps.isPackaged()) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    return runCheckExclusively(async () => {
      const mode = deps.updateMode ? await resolveUpdateMode() : "automatic";
      if (intent === "automatic" && mode === "off") {
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
        });
      }
      if (intent === "manual") {
        preparationError = null;
      }
      configureRuntime(
        releaseChannel,
        intent,
        resolveAutoDownload(mode, autoDownload),
        autoDownload,
      );

      try {
        const result = await deps.runtime.checkForUpdates();
        if (intent === "automatic" && deps.updateMode && (await resolveUpdateMode()) === "off") {
          return buildCheckResult({
            currentVersion,
            hasUpdate: false,
            readyToInstall: false,
          });
        }
        if (!result || !result.updateInfo) {
          clearUpdateState();
          return buildCheckResult({
            currentVersion,
            hasUpdate: false,
            readyToInstall: false,
          });
        }

        if (!result.isUpdateAvailable) {
          const admittedUpdate = buildPreviouslyAdmittedUpdateResult(
            currentVersion,
            result.updateInfo,
          );
          if (admittedUpdate) {
            return admittedUpdate;
          }

          clearUpdateState();
          return buildCheckResult({
            currentVersion,
            hasUpdate: false,
            readyToInstall: false,
          });
        }

        return resolveAvailableUpdateResult(currentVersion, result.updateInfo);
      } catch (error) {
        deps.reportCheckError?.(error);
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
          errorMessage: getErrorMessage(error),
        });
      }
    });
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
      autoDownload: false,
    });
    if (!check.hasUpdate) {
      return {
        installed: false,
        version: currentVersion,
        message: check.errorMessage ?? "No update available.",
        ...(check.errorMessage ? { errorMessage: check.errorMessage } : {}),
      };
    }

    return installCachedUpdate(currentVersion, { onBeforeQuit, restart: true });
  }

  function clearPreparingVersion(version: string): void {
    if (preparingUpdateVersion === version) {
      preparingUpdateVersion = null;
    }
    deps.onDownloadProgress?.(null);
  }

  function shouldRetryStaleDownloadError(
    attemptedVersion: string,
    readyVersion: string,
    signal?: AbortSignal,
  ): boolean {
    return (
      attemptedVersion !== readyVersion &&
      cachedUpdateInfo?.version === readyVersion &&
      !signal?.aborted
    );
  }

  async function ensureUpdateDownloaded(
    readyVersion: string,
    signal?: AbortSignal,
  ): Promise<"ready" | "aborted" | "superseded"> {
    while (!isReadyToInstallVersion(readyVersion)) {
      if (signal?.aborted) return "aborted";
      if (cachedUpdateInfo?.version !== readyVersion) return "superseded";

      const attemptedVersion: string = preparingUpdateVersion ?? readyVersion;
      preparingUpdateVersion ??= readyVersion;
      if (preparationError?.version === attemptedVersion) {
        preparationError = null;
      }
      try {
        await deps.runtime.downloadUpdate(attemptedVersion);
      } catch (error) {
        clearPreparingVersion(attemptedVersion);
        if (shouldRetryStaleDownloadError(attemptedVersion, readyVersion, signal)) {
          continue;
        }
        throw error;
      }

      // electron-updater can return an older, already-running download. Its
      // event clears that version, then the next iteration starts the newly
      // validated release instead of treating the stale artifact as ready.
      if (attemptedVersion === readyVersion && !isReadyToInstallVersion(readyVersion)) {
        downloadedUpdateVersion = readyVersion;
        clearPreparingVersion(readyVersion);
      } else if (preparingUpdateVersion === attemptedVersion) {
        clearPreparingVersion(attemptedVersion);
      }
    }

    return signal?.aborted ? "aborted" : "ready";
  }

  async function installCachedUpdate(
    currentVersion: string,
    {
      onBeforeQuit,
      signal,
      restart,
    }: {
      onBeforeQuit?: () => Promise<void>;
      signal?: AbortSignal;
      restart: boolean;
    },
  ): Promise<AppUpdateInstallResult> {
    if (!cachedUpdateInfo) {
      return {
        installed: false,
        version: currentVersion,
        message: "No update available. Check for updates first.",
      };
    }

    const readyVersion = cachedUpdateInfo.version;
    if (signal?.aborted) {
      return buildDeferredInstallResult(currentVersion);
    }

    try {
      if (!isReadyToInstallVersion(readyVersion)) {
        const preparation = await ensureUpdateDownloaded(readyVersion, signal);
        if (preparation === "aborted") {
          return buildDeferredInstallResult(currentVersion);
        }
        if (preparation === "superseded") {
          return {
            installed: false,
            version: currentVersion,
            message: "A newer update was found and will be installed later.",
          };
        }
      }
      await performQuitAndInstall(deps.runtime, {
        targetVersion: readyVersion,
        onBeforeQuit,
        restart,
      });

      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    } catch (error) {
      deps.onDownloadProgress?.(null);
      const message = error instanceof Error ? error.message : String(error);
      deps.reportInstallError?.(message);
      return {
        installed: false,
        version: currentVersion,
        message: `Update failed: ${message}`,
        errorMessage: message,
      };
    }
  }

  async function installUpdateOnQuit({
    currentVersion,
    releaseChannel,
    signal,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    signal: AbortSignal;
  }): Promise<boolean> {
    if (!deps.isPackaged() || !downloadedUpdateVersion) {
      return false;
    }
    if ((await resolveUpdateMode()) !== "automatic") {
      return false;
    }

    const check = await checkForAppUpdate({
      currentVersion,
      releaseChannel,
      intent: "automatic",
    });
    if (signal.aborted || !check.hasUpdate) {
      return false;
    }

    const result = await installCachedUpdate(currentVersion, { signal, restart: false });
    return result.installed;
  }

  return {
    checkForAppUpdate,
    downloadAndInstallUpdate,
    installUpdateOnQuit,
  };
}
