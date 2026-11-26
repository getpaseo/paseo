import type { DesktopUpdateMode } from "../settings/desktop-settings.js";
import type { AppUpdatePacing } from "./app-update-pacing.js";
import {
  isPacedRelease,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";
import { isNextPatchRelease } from "./app-update-version.js";

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
  /** Position of this install in the rollout of `version`, in [0, 1). */
  bucket(version: string): Promise<number>;
  pacing: AppUpdatePacing;
  updateMode?: () => DesktopUpdateMode | Promise<DesktopUpdateMode>;
  onDownloadProgress?(progress: AppUpdateDownloadProgress | null): void;
  reportSettingsError?(error: unknown): void;
  reportCheckError?(error: unknown): void;
  reportAdmissionError?(error: unknown): void;
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
  // The newest release seen in an unbroken run of paced releases since the
  // staged update became ready. Null whenever nothing is staged.
  let stagedChainHead: string | null = null;
  let currentAutoDownload = true;
  let checkQueue: Promise<void> = Promise.resolve();

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function setStagedUpdate(version: string | null): void {
    downloadedUpdateVersion = version;
    stagedChainHead = version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    setStagedUpdate(null);
    preparationError = null;
    preparingUpdateVersion = null;
    deps.onDownloadProgress?.(null);
  }

  /** What is already known about an update, without asking the release feed. */
  function buildKnownUpdateResult(currentVersion: string): AppUpdateCheckResult {
    const info = cachedUpdateInfo;
    if (!info || info.version === currentVersion) {
      return buildCheckResult({ currentVersion, hasUpdate: false, readyToInstall: false });
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

  function buildPreviouslyAdmittedUpdateResult(
    currentVersion: string,
    checkedInfo: RuntimeUpdateInfo,
  ): AppUpdateCheckResult | null {
    const info = cachedUpdateInfo;
    if (!info || info.version === currentVersion || info.version !== checkedInfo.version) {
      return null;
    }
    return buildKnownUpdateResult(currentVersion);
  }

  /**
   * A staged update is not replaced by the paced release that follows it, so
   * an install that is slow to restart does not download every release. The
   * hold covers only a run of paced releases seen one after the other: a gap
   * means a release was missed, and the missed one may have been the fix for
   * the staged one. Emergency releases and manual checks always replace it.
   */
  function stagedUpdateHoldsAgainst(
    info: RuntimeUpdateInfo,
    releaseChannel: AppReleaseChannel,
  ): boolean {
    const staged = downloadedUpdateVersion;
    if (staged === null || stagedChainHead === null) return false;
    if (cachedUpdateInfo?.version !== staged || info.version === staged) return false;

    const { rolloutHours } = rolloutManifestSchema.parse(info);
    if (!isPacedRelease({ channel: releaseChannel, rolloutHours })) return false;

    return info.version === stagedChainHead || isNextPatchRelease(stagedChainHead, info.version);
  }

  /**
   * Whether an automatic check may take this release now. Any failure to
   * decide admits the release: an install is never refused an update because
   * its own rollout state could not be read.
   */
  async function admitsAutomatically(
    info: RuntimeUpdateInfo,
    releaseChannel: AppReleaseChannel,
  ): Promise<boolean> {
    try {
      const { rolloutHours, releaseDate } = rolloutManifestSchema.parse(info);
      if (!isPacedRelease({ channel: releaseChannel, rolloutHours })) return true;
      if (stagedUpdateHoldsAgainst(info, releaseChannel)) return false;
      if (await deps.pacing.isInUpdateCooldown()) return false;

      return shouldAdmitAppUpdate({
        channel: releaseChannel,
        intent: "automatic",
        rolloutHours,
        releaseDate,
        now: deps.now(),
        bucket: await deps.bucket(info.version),
      });
    } catch (error) {
      deps.reportAdmissionError?.(error);
      return true;
    }
  }

  /** An admitted update that is neither downloaded nor downloading. */
  function hasUnpreparedUpdate(currentVersion: string): boolean {
    const info = cachedUpdateInfo;
    return (
      info !== null &&
      info.version !== currentVersion &&
      !isReadyToInstallVersion(info.version) &&
      preparingUpdateVersion !== info.version
    );
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
        // A manual check needs no rollout or pacing state, so nothing that
        // breaks that state can stop the user from updating by hand.
        const admitted = intent === "manual" || (await admitsAutomatically(info, releaseChannel));
        // Read the mode after every other await, so a mode saved during the
        // check is the one that decides.
        const liveMode = await resolveUpdateMode();
        if (intent === "automatic" && liveMode === "off") {
          return false;
        }
        if (admitted) {
          currentAutoDownload = resolveAutoDownload(liveMode, autoDownloadOverride);
          deps.runtime.setAutoDownload?.(currentAutoDownload);
        }
        return admitted;
      },
      onUpdateAvailable(info) {
        const alreadyReady = downloadedUpdateVersion === info.version;
        cachedUpdateInfo = info;
        if (!alreadyReady) setStagedUpdate(null);
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
        setStagedUpdate(info.version);
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

  /**
   * The release feed answered with a release this check may not take. An
   * update admitted earlier survives only when the feed still names it, or
   * when it is staged and holds against the release the feed names now.
   */
  function resolveUnavailableUpdateResult(
    check: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
      intent: AppUpdateCheckIntent;
    },
    info: RuntimeUpdateInfo,
  ): AppUpdateCheckResult {
    const admittedUpdate = buildPreviouslyAdmittedUpdateResult(check.currentVersion, info);
    if (admittedUpdate) {
      return admittedUpdate;
    }

    if (check.intent === "automatic" && stagedUpdateHoldsAgainst(info, check.releaseChannel)) {
      stagedChainHead = info.version;
      return buildKnownUpdateResult(check.currentVersion);
    }

    clearUpdateState();
    return buildCheckResult({
      currentVersion: check.currentVersion,
      hasUpdate: false,
      readyToInstall: false,
    });
  }

  /**
   * Reasons to ask the release feed before the next check is due: a change of
   * channel makes the known update stale, and an update that should be
   * downloading but is not needs the check to start it again.
   */
  function mustCheckNow(
    currentVersion: string,
    releaseChannel: AppReleaseChannel,
    autoDownload: boolean,
  ): boolean {
    const channelChanged =
      configuredReleaseChannel !== null && configuredReleaseChannel !== releaseChannel;
    return channelChanged || (autoDownload && hasUnpreparedUpdate(currentVersion));
  }

  interface UpdateCheckInput {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
    autoDownload?: boolean;
  }

  /**
   * `spaced` checks are the background ones the app makes on its own. On the
   * stable channel they ask the release feed at most once per pacing interval
   * and answer from what is already known in between.
   */
  async function runUpdateCheck(
    { currentVersion, releaseChannel, intent, autoDownload }: UpdateCheckInput,
    { spaced }: { spaced: boolean },
  ): Promise<AppUpdateCheckResult> {
    if (!deps.isPackaged()) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    return runCheckExclusively(async () => {
      const respectsInterval = spaced && intent === "automatic" && releaseChannel === "stable";
      const checkIsDue = respectsInterval ? await deps.pacing.isAutomaticCheckDue() : true;

      const mode = deps.updateMode ? await resolveUpdateMode() : "automatic";
      if (intent === "automatic" && mode === "off") {
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
        });
      }

      const initialAutoDownload = resolveAutoDownload(mode, autoDownload);
      if (!checkIsDue && !mustCheckNow(currentVersion, releaseChannel, initialAutoDownload)) {
        return buildKnownUpdateResult(currentVersion);
      }

      if (intent === "manual") {
        preparationError = null;
      }
      configureRuntime(releaseChannel, intent, initialAutoDownload, autoDownload);

      try {
        const result = await deps.runtime.checkForUpdates();
        // Only a check that read the release feed counts. A failed check
        // throws, and an unreadable feed answers null: both run again at the
        // next opportunity.
        if (respectsInterval && result) {
          await deps.pacing.recordAutomaticCheck();
        }
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
          return resolveUnavailableUpdateResult(
            { currentVersion, releaseChannel, intent },
            result.updateInfo,
          );
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

  function checkForAppUpdate(input: UpdateCheckInput): Promise<AppUpdateCheckResult> {
    return runUpdateCheck(input, { spaced: true });
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

    const check = await runUpdateCheck(
      { currentVersion, releaseChannel, intent: "manual", autoDownload: false },
      { spaced: false },
    );
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
        setStagedUpdate(readyVersion);
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

    // The staged update is validated against the release feed before every
    // install, however recently the app last checked.
    const check = await runUpdateCheck(
      { currentVersion, releaseChannel, intent: "automatic" },
      { spaced: false },
    );
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
