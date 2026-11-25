import type {
  DesktopAppUpdateCheckResult,
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateDownloadProgress,
  DesktopAppUpdateInstallResult,
  DesktopReleaseChannel,
} from "@/desktop/updates/desktop-updates";
import { i18n } from "@/i18n/i18next";

export type DesktopAppUpdateStatus =
  | "idle"
  | "checking"
  | "pending"
  | "up-to-date"
  | "available"
  | "installing"
  | "installed"
  | "error";

export const PENDING_RECHECK_MS = 10_000;

export interface DesktopAppUpdaterSnapshot {
  status: DesktopAppUpdateStatus;
  availableUpdate: DesktopAppUpdateCheckResult | null;
  downloadProgress: DesktopAppUpdateDownloadProgress | null;
  errorMessage: string | null;
  installMessage: string | null;
  lastCheckedAt: number | null;
  isChecking: boolean;
  isInstalling: boolean;
}

export interface DesktopAppUpdaterPort {
  checkDesktopAppUpdate(input: {
    releaseChannel: DesktopReleaseChannel;
    intent: DesktopAppUpdateCheckIntent;
  }): Promise<DesktopAppUpdateCheckResult>;
  installDesktopAppUpdate(input: {
    releaseChannel: DesktopReleaseChannel;
  }): Promise<DesktopAppUpdateInstallResult>;
}

export interface DesktopAppUpdaterErrorReport {
  error: unknown;
  message: string;
  logLabel: string;
}

export interface DesktopAppUpdaterDeps {
  port: DesktopAppUpdaterPort;
  now(): number;
  reportInstallError?(report: DesktopAppUpdaterErrorReport): void;
}

export interface DesktopAppUpdater {
  getSnapshot(): DesktopAppUpdaterSnapshot;
  subscribe(listener: () => void): () => void;
  setDownloadProgress(progress: DesktopAppUpdateDownloadProgress | null): void;
  checkForUpdates(options?: {
    releaseChannel: DesktopReleaseChannel;
    intent?: DesktopAppUpdateCheckIntent;
    silent?: boolean;
  }): Promise<DesktopAppUpdateCheckResult | null>;
  installUpdate(options: {
    releaseChannel: DesktopReleaseChannel;
  }): Promise<DesktopAppUpdateInstallResult | null>;
}

interface InternalState {
  status: DesktopAppUpdateStatus;
  availableUpdate: DesktopAppUpdateCheckResult | null;
  downloadProgress: DesktopAppUpdateDownloadProgress | null;
  errorMessage: string | null;
  installMessage: string | null;
  lastCheckedAt: number | null;
  isInstalling: boolean;
  requestVersion: number;
}

const INITIAL_STATE: InternalState = {
  status: "idle",
  availableUpdate: null,
  downloadProgress: null,
  errorMessage: null,
  installMessage: null,
  lastCheckedAt: null,
  isInstalling: false,
  requestVersion: 0,
};

function buildSnapshot(state: InternalState): DesktopAppUpdaterSnapshot {
  return {
    status: state.status,
    availableUpdate: state.availableUpdate,
    downloadProgress: state.downloadProgress,
    errorMessage: state.errorMessage,
    installMessage: state.installMessage,
    lastCheckedAt: state.lastCheckedAt,
    isChecking: state.status === "checking",
    isInstalling: state.status === "installing" || state.isInstalling,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function formatInstallingStatusText(input: {
  availableUpdate: DesktopAppUpdateCheckResult | null;
  downloadProgress: DesktopAppUpdateDownloadProgress | null;
  formatVersion: (version: string | null | undefined) => string;
}): string {
  const { availableUpdate, downloadProgress, formatVersion } = input;
  if (downloadProgress == null) {
    return i18n.t("desktop.updates.status.installing");
  }
  const percent = Math.round(downloadProgress.percent);
  const version = downloadProgress.version ?? availableUpdate?.latestVersion;
  if (version) {
    return i18n.t("desktop.updates.status.downloadingVersionProgress", {
      version: formatVersion(version),
      percent,
    });
  }
  return i18n.t("desktop.updates.status.downloadingProgress", { percent });
}

function formatPendingStatusText(input: {
  availableUpdate: DesktopAppUpdateCheckResult | null;
  downloadProgress: DesktopAppUpdateDownloadProgress | null;
  lastCheckedAt: number | null;
  formatVersion: (version: string | null | undefined) => string;
  formatLastCheckedAt: (timestamp: number) => string;
}): string {
  const { availableUpdate, downloadProgress, lastCheckedAt, formatVersion, formatLastCheckedAt } =
    input;
  const time = lastCheckedAt != null ? formatLastCheckedAt(lastCheckedAt) : undefined;
  if (availableUpdate?.latestVersion) {
    const version = formatVersion(availableUpdate.latestVersion);
    if (downloadProgress != null) {
      return i18n.t(
        time !== undefined
          ? "desktop.updates.status.pendingWithVersionProgressAndLastChecked"
          : "desktop.updates.status.pendingWithVersionProgress",
        { version, percent: Math.round(downloadProgress.percent), time },
      );
    }
    return i18n.t(
      time !== undefined
        ? "desktop.updates.status.pendingWithVersionAndLastChecked"
        : "desktop.updates.status.pendingWithVersion",
      { version, time },
    );
  }
  if (time !== undefined) {
    return i18n.t("desktop.updates.status.pendingWithLastChecked", { time });
  }
  return i18n.t("desktop.updates.status.pending");
}

function formatAvailableStatusText(input: {
  availableUpdate: DesktopAppUpdateCheckResult | null;
  lastCheckedAt: number | null;
  formatVersion: (version: string | null | undefined) => string;
  formatLastCheckedAt: (timestamp: number) => string;
}): string {
  const { availableUpdate, lastCheckedAt, formatVersion, formatLastCheckedAt } = input;
  const time = lastCheckedAt != null ? formatLastCheckedAt(lastCheckedAt) : undefined;
  const isDownloadRequired =
    availableUpdate?.hasUpdate === true && availableUpdate.readyToInstall === false;
  if (availableUpdate?.latestVersion) {
    const version = formatVersion(availableUpdate.latestVersion);
    if (isDownloadRequired) {
      return i18n.t(
        time !== undefined
          ? "desktop.updates.status.downloadAvailableWithVersionAndLastChecked"
          : "desktop.updates.status.downloadAvailableWithVersion",
        { version, time },
      );
    }
    return i18n.t(
      time !== undefined
        ? "desktop.updates.status.availableWithVersionAndLastChecked"
        : "desktop.updates.status.availableWithVersion",
      { version, time },
    );
  }
  if (isDownloadRequired) {
    return time !== undefined
      ? i18n.t("desktop.updates.status.downloadAvailableWithLastChecked", { time })
      : i18n.t("desktop.updates.status.downloadAvailable");
  }
  return time !== undefined
    ? i18n.t("desktop.updates.status.availableWithLastChecked", { time })
    : i18n.t("desktop.updates.status.available");
}

function resolveCheckOutcome(result: DesktopAppUpdateCheckResult): {
  status: DesktopAppUpdateStatus;
  availableUpdate: DesktopAppUpdateCheckResult | null;
} {
  if (result.readyToInstall || (result.hasUpdate && !result.downloading)) {
    return { status: "available", availableUpdate: result };
  }
  if (result.hasUpdate) {
    return { status: "pending", availableUpdate: result };
  }
  return { status: "up-to-date", availableUpdate: null };
}

export function formatStatusText(input: {
  status: DesktopAppUpdateStatus;
  availableUpdate: DesktopAppUpdateCheckResult | null;
  downloadProgress?: DesktopAppUpdateDownloadProgress | null;
  installMessage: string | null;
  lastCheckedAt: number | null;
  formatVersion: (version: string | null | undefined) => string;
  formatLastCheckedAt: (timestamp: number) => string;
}): string {
  const {
    status,
    availableUpdate,
    downloadProgress = null,
    installMessage,
    lastCheckedAt,
    formatVersion,
    formatLastCheckedAt,
  } = input;

  if (status === "checking") return i18n.t("desktop.updates.status.checking");
  if (status === "installing") {
    return formatInstallingStatusText({ availableUpdate, downloadProgress, formatVersion });
  }
  if (status === "up-to-date") {
    return lastCheckedAt != null
      ? i18n.t("desktop.updates.status.upToDateWithLastChecked", {
          time: formatLastCheckedAt(lastCheckedAt),
        })
      : i18n.t("desktop.updates.status.upToDate");
  }
  if (status === "pending") {
    return formatPendingStatusText({
      availableUpdate,
      downloadProgress,
      lastCheckedAt,
      formatVersion,
      formatLastCheckedAt,
    });
  }
  if (status === "available") {
    return formatAvailableStatusText({
      availableUpdate,
      lastCheckedAt,
      formatVersion,
      formatLastCheckedAt,
    });
  }
  if (status === "installed") {
    return installMessage ?? i18n.t("desktop.updates.status.installed");
  }
  if (status === "error") return i18n.t("desktop.updates.status.failed");
  return i18n.t("desktop.updates.status.idle");
}

export function createDesktopAppUpdater(deps: DesktopAppUpdaterDeps): DesktopAppUpdater {
  let state: InternalState = { ...INITIAL_STATE };
  let cachedSnapshot: DesktopAppUpdaterSnapshot = buildSnapshot(state);
  const listeners = new Set<() => void>();

  function commit(next: InternalState): void {
    state = next;
    cachedSnapshot = buildSnapshot(state);
    for (const listener of listeners) {
      listener();
    }
  }

  function setDownloadProgress(progress: DesktopAppUpdateDownloadProgress | null): void {
    if (progress === null && state.downloadProgress === null) {
      return;
    }
    commit({
      ...state,
      downloadProgress: progress,
    });
  }

  async function checkForUpdates(options?: {
    releaseChannel: DesktopReleaseChannel;
    intent?: DesktopAppUpdateCheckIntent;
    silent?: boolean;
  }): Promise<DesktopAppUpdateCheckResult | null> {
    if (!options) {
      return null;
    }
    const { releaseChannel, intent = "manual", silent = false } = options;
    if (silent && (state.status === "checking" || state.isInstalling)) {
      return null;
    }

    const requestVersion = state.requestVersion + 1;

    commit({
      ...state,
      requestVersion,
      status: silent ? state.status : "checking",
      errorMessage: silent ? state.errorMessage : null,
    });

    try {
      const result = await deps.port.checkDesktopAppUpdate({ releaseChannel, intent });
      if (requestVersion !== state.requestVersion) {
        return result;
      }

      const nextLastCheckedAt = intent === "manual" ? deps.now() : state.lastCheckedAt;
      if (result.errorMessage) {
        if (silent && !result.hasUpdate) {
          console.warn("[DesktopUpdater] Silent update check failed", result.errorMessage);
          return result;
        }

        commit({
          ...state,
          status: "error",
          availableUpdate: null,
          downloadProgress: null,
          errorMessage: result.errorMessage,
          installMessage: null,
          lastCheckedAt: nextLastCheckedAt,
        });
        return result;
      }

      const outcome = resolveCheckOutcome(result);

      commit({
        ...state,
        status: outcome.status,
        availableUpdate: outcome.availableUpdate,
        downloadProgress: outcome.status === "pending" ? state.downloadProgress : null,
        errorMessage: null,
        installMessage: null,
        lastCheckedAt: nextLastCheckedAt,
      });

      return result;
    } catch (error) {
      if (requestVersion !== state.requestVersion) {
        return null;
      }

      const message = getErrorMessage(error);
      if (silent) {
        console.warn("[DesktopUpdater] Silent update check failed", message);
      } else {
        commit({
          ...state,
          status: "error",
          downloadProgress: null,
          errorMessage: message,
          lastCheckedAt: intent === "manual" ? deps.now() : state.lastCheckedAt,
        });
      }
      return null;
    }
  }

  async function installUpdate(options: {
    releaseChannel: DesktopReleaseChannel;
  }): Promise<DesktopAppUpdateInstallResult | null> {
    if (state.isInstalling) {
      return null;
    }

    commit({
      ...state,
      status: "installing",
      errorMessage: null,
      isInstalling: true,
    });

    try {
      const result = await deps.port.installDesktopAppUpdate({
        releaseChannel: options.releaseChannel,
      });
      const nextLastCheckedAt = deps.now();
      if (!result.installed && result.errorMessage) {
        commit({
          ...state,
          status: "error",
          downloadProgress: null,
          errorMessage: result.errorMessage,
          installMessage: null,
          lastCheckedAt: nextLastCheckedAt,
          isInstalling: false,
        });
        return result;
      }
      commit({
        ...state,
        status: result.installed ? "installed" : "up-to-date",
        availableUpdate: null,
        downloadProgress: null,
        installMessage: result.message,
        lastCheckedAt: nextLastCheckedAt,
        isInstalling: false,
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      deps.reportInstallError?.({
        error,
        message: i18n.t("desktop.updates.installError"),
        logLabel: "[DesktopUpdater] Failed to install app update",
      });
      commit({
        ...state,
        status: "error",
        downloadProgress: null,
        errorMessage: message,
        isInstalling: false,
      });
      return null;
    }
  }

  return {
    getSnapshot: () => cachedSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDownloadProgress,
    checkForUpdates,
    installUpdate,
  };
}
