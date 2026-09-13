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

export type AppUpdateStartupInstallResult =
  | { installed: true; version: string }
  | {
      installed: false;
      reason: "unsupported" | "no-update" | "not-ready" | "timeout" | "error";
    };

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
  onError(error: unknown): void;
}

export interface AppUpdateInstallRequest {
  targetVersion: string;
  isSilent: boolean;
  isForceRunAfter: boolean;
}

export interface AppUpdateRuntime {
  configure(input: AppUpdateRuntimeConfiguration): void;
  checkForUpdates(): Promise<RuntimeUpdateCheckResult | null>;
  downloadUpdate(targetVersion: string): Promise<unknown>;
  quitAndInstall(input: AppUpdateInstallRequest): void;
}

/**
 * Records the version of an update that was downloaded but not installed, so the
 * next launch knows a pending installer exists without having to inspect
 * electron-updater's private update cache.
 */
export interface PendingUpdateStore {
  read(): Promise<string | null>;
  write(version: string): Promise<void>;
  clear(): Promise<void>;
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
    onBeforeInstall?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult>;
  installPendingUpdateOnStartup(
    input: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
      signal: AbortSignal;
    },
    onBeforeInstall?: () => Promise<void>,
  ): Promise<AppUpdateStartupInstallResult>;
}

export interface AppUpdateServiceDeps {
  runtime: AppUpdateRuntime;
  isPackaged(): boolean;
  now(): number;
  bucket(): Promise<number>;
  pendingUpdateStore: PendingUpdateStore;
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

async function performInstall(
  runtime: AppUpdateRuntime,
  {
    targetVersion,
    onBeforeInstall,
    silent,
    forceRunAfter,
  }: {
    targetVersion: string;
    onBeforeInstall?: () => Promise<void>;
    silent: boolean;
    forceRunAfter: boolean;
  },
): Promise<void> {
  if (onBeforeInstall) await onBeforeInstall();
  runtime.quitAndInstall({
    targetVersion,
    isSilent: silent,
    isForceRunAfter: forceRunAfter,
  });
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
  let checkQueue: Promise<void> = Promise.resolve();
  const readyWaiters = new Set<() => void>();

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function signalReadyChange(): void {
    for (const waiter of readyWaiters) {
      waiter();
    }
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    preparationError = null;
    preparingUpdateVersion = null;
    signalReadyChange();
  }

  function markUpdateDownloaded(version: string): void {
    downloadedUpdateVersion = version;
    signalReadyChange();
    void deps.pendingUpdateStore.write(version).catch((error) => {
      deps.reportInstallError?.(`Failed to record the pending update: ${getErrorMessage(error)}`);
    });
  }

  async function clearPendingUpdate(): Promise<void> {
    try {
      await deps.pendingUpdateStore.clear();
    } catch (error) {
      deps.reportInstallError?.(`Failed to clear the pending update: ${getErrorMessage(error)}`);
    }
  }

  function buildPreviouslyAdmittedUpdateResult(
    currentVersion: string,
    checkedInfo: RuntimeUpdateInfo,
  ): AppUpdateCheckResult | null {
    const info = cachedUpdateInfo;
    if (!info || info.version === currentVersion || info.version !== checkedInfo.version) {
      return null;
    }

    return buildCheckResult({
      currentVersion,
      hasUpdate: true,
      readyToInstall: isReadyToInstallVersion(info.version),
      info,
      errorMessage: preparationError?.version === info.version ? preparationError.message : null,
    });
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
        if (!alreadyReady && preparingUpdateVersion === null) {
          preparingUpdateVersion = info.version;
        }
      },
      onUpdateDownloaded(info) {
        // A superseded download can finish after a newer manifest check. Keep
        // the validated manifest as the install target in that case.
        cachedUpdateInfo ??= info;
        markUpdateDownloaded(info.version);
        if (preparingUpdateVersion === info.version) {
          preparingUpdateVersion = null;
        }
        if (preparationError?.version === info.version) {
          preparationError = null;
        }
      },
      onError(error) {
        if (preparingUpdateVersion) {
          preparationError = {
            version: preparingUpdateVersion,
            message: getErrorMessage(error),
          };
          preparingUpdateVersion = null;
        }
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

    return runCheckExclusively(async () => {
      configureRuntime(releaseChannel, intent);

      try {
        const result = await deps.runtime.checkForUpdates();
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

        const info = result.updateInfo;
        const latestVersion = info.version;
        const hasUpdate = latestVersion !== currentVersion;

        if (hasUpdate) {
          cachedUpdateInfo = info;
          const errorMessage =
            preparationError?.version === latestVersion ? preparationError.message : null;
          if (!errorMessage) {
            preparationError = null;
          }
          return buildCheckResult({
            currentVersion,
            hasUpdate: true,
            readyToInstall: isReadyToInstallVersion(latestVersion),
            info,
            errorMessage,
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
    onBeforeInstall?: () => Promise<void>,
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

    return installCachedUpdate(currentVersion, {
      onBeforeInstall,
      silent: false,
      forceRunAfter: true,
    });
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
      try {
        await deps.runtime.downloadUpdate(attemptedVersion);
      } catch (error) {
        if (
          attemptedVersion !== readyVersion &&
          cachedUpdateInfo?.version === readyVersion &&
          !signal?.aborted
        ) {
          continue;
        }
        throw error;
      }

      // electron-updater can return an older, already-running download. Its
      // event clears that version, then the next iteration starts the newly
      // validated release instead of treating the stale artifact as ready.
      if (attemptedVersion === readyVersion && !isReadyToInstallVersion(readyVersion)) {
        markUpdateDownloaded(readyVersion);
        preparingUpdateVersion = null;
      }
    }

    return signal?.aborted ? "aborted" : "ready";
  }

  async function waitForUpdateReady(version: string, signal: AbortSignal): Promise<boolean> {
    while (!isReadyToInstallVersion(version)) {
      if (signal.aborted) return false;
      if (cachedUpdateInfo?.version !== version) return false;

      await new Promise<void>((resolve) => {
        const settle = () => {
          readyWaiters.delete(settle);
          signal.removeEventListener("abort", settle);
          resolve();
        };
        readyWaiters.add(settle);
        signal.addEventListener("abort", settle, { once: true });
      });
    }

    return true;
  }

  async function installCachedUpdate(
    currentVersion: string,
    {
      onBeforeInstall,
      signal,
      silent,
      forceRunAfter,
    }: {
      onBeforeInstall?: () => Promise<void>;
      signal?: AbortSignal;
      silent: boolean;
      forceRunAfter: boolean;
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

    if (isReadyToInstallVersion(readyVersion)) {
      await performInstall(deps.runtime, {
        targetVersion: readyVersion,
        onBeforeInstall,
        silent,
        forceRunAfter,
      });
      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    }

    try {
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
      await performInstall(deps.runtime, {
        targetVersion: readyVersion,
        onBeforeInstall,
        silent,
        forceRunAfter,
      });

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

  async function installPendingUpdateOnStartup(
    {
      currentVersion,
      releaseChannel,
      signal,
    }: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
      signal: AbortSignal;
    },
    onBeforeInstall?: () => Promise<void>,
  ): Promise<AppUpdateStartupInstallResult> {
    if (!deps.isPackaged()) {
      return { installed: false, reason: "unsupported" };
    }

    try {
      // The pending-update record is the predicate. Only an update that was
      // already downloaded is installed here, so a clean session never asks
      // electron-updater to fetch anything at startup.
      const pendingVersion = await deps.pendingUpdateStore.read();
      if (!pendingVersion) {
        return { installed: false, reason: "no-update" };
      }

      const check = await checkForAppUpdate({
        currentVersion,
        releaseChannel,
        intent: "automatic",
      });
      if (signal.aborted) {
        return { installed: false, reason: "timeout" };
      }

      if (!check.hasUpdate) {
        if (check.errorMessage) {
          // A failed check cannot disprove the pending update, so keep it for
          // the next launch instead of dropping it.
          return { installed: false, reason: "not-ready" };
        }
        await clearPendingUpdate();
        return { installed: false, reason: "no-update" };
      }

      if (check.latestVersion !== pendingVersion) {
        return { installed: false, reason: "no-update" };
      }

      const ready = check.readyToInstall || (await waitForUpdateReady(pendingVersion, signal));
      if (!ready) {
        return { installed: false, reason: signal.aborted ? "timeout" : "not-ready" };
      }

      const result = await installCachedUpdate(currentVersion, {
        onBeforeInstall,
        signal,
        silent: true,
        forceRunAfter: true,
      });
      if (!result.installed) {
        return { installed: false, reason: "error" };
      }

      await clearPendingUpdate();
      return { installed: true, version: result.version ?? pendingVersion };
    } catch (error) {
      deps.reportInstallError?.(getErrorMessage(error));
      return { installed: false, reason: "error" };
    }
  }

  return {
    checkForAppUpdate,
    downloadAndInstallUpdate,
    installPendingUpdateOnStartup,
  };
}
