import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { globalCliPackageManagers, type GlobalCliPackageManager } from "./global-cli.js";
import {
  daemonInstallOriginRuntime,
  resolveGlobalCliSelfUpdate,
  type DaemonInstallOriginRuntime,
} from "./install-origin.js";

export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
}

export interface DaemonSelfUpdateInput {
  daemonVersion: string | null;
  desktopManaged: boolean;
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface DaemonSelfUpdateRuntime {
  managers: readonly GlobalCliPackageManager[];
  installOrigin: DaemonInstallOriginRuntime;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

const defaultRuntime: DaemonSelfUpdateRuntime = {
  managers: globalCliPackageManagers,
  installOrigin: daemonInstallOriginRuntime,
};

const DESKTOP_MANAGED_UPDATE_ERROR =
  "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.";

export class DaemonSelfUpdater {
  private inProgress = false;

  constructor(private readonly runtime: DaemonSelfUpdateRuntime = defaultRuntime) {}

  async update(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    if (input.desktopManaged) {
      return { success: false, error: DESKTOP_MANAGED_UPDATE_ERROR, newVersion: null };
    }

    if (this.inProgress) {
      throw new DaemonSelfUpdateInProgressError();
    }

    this.inProgress = true;
    try {
      input.onProgress("starting");
      const resolution = await resolveGlobalCliSelfUpdate(
        this.runtime.managers,
        input.daemonVersion,
        this.runtime.installOrigin,
      );
      if (!resolution.ok) {
        return { success: false, error: resolution.error, newVersion: null };
      }
      const { manager } = resolution.target;

      input.onProgress("downloading");
      input.onProgress("installing");

      const result = await manager.installLatest();
      if (result.exitCode !== 0) {
        const error =
          result.stderr.trim() ||
          result.stdout.trim() ||
          `${manager.name} exited with code ${result.exitCode}`;
        input.logger.error(
          { packageManager: manager.name, exitCode: result.exitCode, stderr: result.stderr },
          "Daemon self-update failed",
        );
        return { success: false, error, newVersion: null };
      }

      const updatedInstall = await manager.inspect().catch((error: unknown) => {
        input.logger.warn({ err: error }, "Unable to read updated global package version");
        return null;
      });

      input.onProgress("complete");
      return { success: true, error: null, newVersion: updatedInstall?.version ?? null };
    } catch (error) {
      input.logger.error({ err: error }, "Daemon self-update failed with exception");
      return { success: false, error: getErrorMessage(error), newVersion: null };
    } finally {
      this.inProgress = false;
    }
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();
