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
  cancelled?: boolean;
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
  cancelDownload(): void;
  quitAndInstall(input: AppUpdateInstallRequest): void;
}

/**
 * Runs `stop` and then installs, with no update check in between. Resolves
 * false without running `stop` when a check replaced the update, so a long
 * wait never stops the daemon for an update that is no longer the target.
 */
export type InstallAfterStop = (stop: () => Promise<void>) => Promise<boolean>;

export type BeforeInstall = (installAfterStop: InstallAfterStop) => Promise<void>;

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
      signal?: AbortSignal;
    },
    beforeInstall?: BeforeInstall,
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function cancelledInstallResult(currentVersion: string): AppUpdateInstallResult {
  return {
    installed: false,
    cancelled: true,
    version: currentVersion,
    message: "Installation cancelled.",
  };
}

function whenAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
        return undefined;
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
        return undefined;
      },
    );
  });
}

function supersededInstallResult(currentVersion: string): AppUpdateInstallResult {
  return {
    installed: false,
    version: currentVersion,
    message: "A newer update was found and will be installed later.",
  };
}

// Cancel stops waiting for a queued install that has not started; the queued
// job then sees the abort and stops nothing. A started stop runs to the end,
// because an accepted stop cannot be undone.
function whenAbortedBeforeStart(
  work: Promise<boolean>,
  signal: AbortSignal | undefined,
  hasStarted: () => boolean,
): Promise<boolean> {
  if (!signal) return work;
  if (signal.aborted && !hasStarted()) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (!hasStarted()) resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    preparationError = null;
    preparingUpdateVersion = null;
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
        downloadedUpdateVersion = info.version;
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

  function isCurrentUpdate(version: string, releaseChannel: AppReleaseChannel): boolean {
    return (
      configuredReleaseChannel === releaseChannel &&
      cachedUpdateInfo?.version === version &&
      isReadyToInstallVersion(version)
    );
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
      signal,
    }: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
      signal?: AbortSignal;
    },
    beforeInstall?: BeforeInstall,
  ): Promise<AppUpdateInstallResult> {
    if (!deps.isPackaged()) {
      return {
        installed: false,
        version: currentVersion,
        message: "Auto-update is not available in development mode.",
      };
    }

    let check: AppUpdateCheckResult;
    try {
      // The check queues behind other windows' checks and the network. Cancel
      // stops waiting for it; the check itself finishes in the queue, and a
      // later install runs its own check after it.
      check = await whenAborted(
        checkForAppUpdate({ currentVersion, releaseChannel, intent: "manual" }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return cancelledInstallResult(currentVersion);
      throw error;
    }
    if (!check.hasUpdate) {
      return {
        installed: false,
        version: currentVersion,
        message: check.errorMessage ?? "No update available.",
      };
    }

    if (signal?.aborted) {
      deps.runtime.cancelDownload();
      return cancelledInstallResult(currentVersion);
    }
    return installCachedUpdate(currentVersion, releaseChannel, {
      beforeInstall,
      restart: true,
      signal,
      cancelOnAbort: true,
    });
  }

  function listenForDownloadAbort(
    signal: AbortSignal | undefined,
    cancelDownload: boolean,
  ): () => void {
    if (!signal || !cancelDownload) return () => undefined;
    const stopDownload = () => deps.runtime.cancelDownload();
    signal.addEventListener("abort", stopDownload);
    return () => signal.removeEventListener("abort", stopDownload);
  }

  // electron-updater can return an older, already-running download, even one
  // from another channel. Its event records that version, then the next
  // iteration starts the newly validated release instead of treating the stale
  // artifact as ready. Only a download that reported nothing else counts as
  // this version.
  function markDownloadedWithoutEvent(attemptedVersion: string, readyVersion: string): void {
    if (
      attemptedVersion === readyVersion &&
      !isReadyToInstallVersion(readyVersion) &&
      downloadedUpdateVersion === null
    ) {
      downloadedUpdateVersion = readyVersion;
      preparingUpdateVersion = null;
    }
  }

  async function downloadReadyUpdate(
    readyVersion: string,
    signal?: AbortSignal,
  ): Promise<"ready" | "aborted" | "superseded"> {
    while (!isReadyToInstallVersion(readyVersion)) {
      if (signal?.aborted) return "aborted";
      if (cachedUpdateInfo?.version !== readyVersion) return "superseded";

      const attemptedVersion: string = preparingUpdateVersion ?? readyVersion;
      preparingUpdateVersion ??= readyVersion;
      try {
        await whenAborted(deps.runtime.downloadUpdate(attemptedVersion), signal);
      } catch (error) {
        if (signal?.aborted) return "aborted";
        if (
          attemptedVersion !== readyVersion &&
          cachedUpdateInfo?.version === readyVersion &&
          !signal?.aborted
        ) {
          continue;
        }
        throw error;
      }

      markDownloadedWithoutEvent(attemptedVersion, readyVersion);
    }

    return signal?.aborted ? "aborted" : "ready";
  }

  async function ensureUpdateDownloaded(
    readyVersion: string,
    signal?: AbortSignal,
    cancelDownloadOnAbort = false,
  ): Promise<"ready" | "aborted" | "superseded"> {
    // whenAborted only stops waiting. A user cancel also has to stop the download.
    const stopListening = listenForDownloadAbort(signal, cancelDownloadOnAbort);
    try {
      const result = await downloadReadyUpdate(readyVersion, signal);
      return signal?.aborted ? "aborted" : result;
    } finally {
      stopListening();
    }
  }

  async function quitAndInstall(
    targetVersion: string,
    releaseChannel: AppReleaseChannel,
    {
      restart,
      signal,
      beforeInstall = (installAfterStop) =>
        installAfterStop(async () => undefined).then(() => undefined),
    }: { restart: boolean; signal?: AbortSignal; beforeInstall?: BeforeInstall },
  ): Promise<"installed" | "cancelled" | "superseded"> {
    let outcome: "installed" | "superseded" | null = null;
    // Holding the check queue keeps a check from another window from changing
    // the channel or the target between the stop and the install.
    const installAfterStop: InstallAfterStop = (stop) => {
      let started = false;
      const install = runCheckExclusively(async () => {
        started = true;
        if (signal?.aborted) return false;
        if (!isCurrentUpdate(targetVersion, releaseChannel)) {
          outcome = "superseded";
          return false;
        }
        await stop();
        deps.runtime.quitAndInstall({
          targetVersion,
          isSilent: !restart,
          isForceRunAfter: restart,
        });
        outcome = "installed";
        return true;
      });
      return whenAbortedBeforeStart(install, signal, () => started);
    };
    await beforeInstall(installAfterStop);
    return outcome ?? "cancelled";
  }

  function buildInstallResult(
    outcome: "installed" | "cancelled" | "superseded",
    currentVersion: string,
    readyVersion: string,
  ): AppUpdateInstallResult {
    if (outcome === "superseded") return supersededInstallResult(currentVersion);
    if (outcome === "cancelled") return cancelledInstallResult(currentVersion);
    return {
      installed: true,
      version: readyVersion,
      message: "Update downloaded. The app will restart shortly.",
    };
  }

  async function installCachedUpdate(
    currentVersion: string,
    releaseChannel: AppReleaseChannel,
    {
      beforeInstall,
      signal,
      restart,
      cancelOnAbort,
    }: {
      beforeInstall?: BeforeInstall;
      signal?: AbortSignal;
      restart: boolean;
      cancelOnAbort?: boolean;
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
      if (cancelOnAbort) deps.runtime.cancelDownload();
      return cancelOnAbort
        ? cancelledInstallResult(currentVersion)
        : buildDeferredInstallResult(currentVersion);
    }

    if (isReadyToInstallVersion(readyVersion)) {
      const outcome = await quitAndInstall(readyVersion, releaseChannel, {
        restart,
        signal,
        beforeInstall,
      });
      return buildInstallResult(outcome, currentVersion, readyVersion);
    }

    try {
      const preparation = await ensureUpdateDownloaded(
        readyVersion,
        signal,
        cancelOnAbort === true,
      );
      if (preparation === "aborted") {
        return cancelOnAbort
          ? cancelledInstallResult(currentVersion)
          : buildDeferredInstallResult(currentVersion);
      }
      if (preparation === "superseded") return supersededInstallResult(currentVersion);
      const outcome = await quitAndInstall(readyVersion, releaseChannel, {
        restart,
        signal,
        beforeInstall,
      });
      return buildInstallResult(outcome, currentVersion, readyVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.reportInstallError?.(message);
      throw error;
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

    const check = await checkForAppUpdate({
      currentVersion,
      releaseChannel,
      intent: "automatic",
    });
    if (signal.aborted || !check.hasUpdate) {
      return false;
    }

    const result = await installCachedUpdate(currentVersion, releaseChannel, {
      signal,
      restart: false,
    });
    return result.installed;
  }

  return {
    checkForAppUpdate,
    downloadAndInstallUpdate,
    installUpdateOnQuit,
  };
}
