import { DaemonInstanceError } from "@getpaseo/server/daemon-control";
import type { AppUpdateInstallResult } from "../features/app-update-service.js";
import type { DesktopDaemonStatus } from "./daemon-manager.js";

type AppUpdateResult = boolean | AppUpdateInstallResult;

export function createDesktopDaemonUpdateLifecycle({
  start,
  stopForUpdate,
}: {
  start: () => Promise<DesktopDaemonStatus>;
  stopForUpdate: () => Promise<unknown>;
}) {
  let pendingStart: Promise<DesktopDaemonStatus> | null = null;
  let installingUpdate = false;

  function startDaemon(): Promise<DesktopDaemonStatus> {
    if (installingUpdate) {
      return Promise.reject(
        new DaemonInstanceError(
          "APP_UPDATE_IN_PROGRESS",
          "Paseo is installing an app update. The daemon cannot start until installation finishes.",
        ),
      );
    }
    pendingStart ??= start().finally(() => {
      pendingStart = null;
    });
    return pendingStart;
  }

  async function install<T extends AppUpdateResult>(
    installer: (prepare: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let prepared = false;
    try {
      const result = await installer(async () => {
        if (installingUpdate) {
          throw new DaemonInstanceError(
            "APP_UPDATE_IN_PROGRESS",
            "An app update is already installing.",
          );
        }
        installingUpdate = true;
        prepared = true;
        await pendingStart;
        await stopForUpdate();
      });
      const installed = typeof result === "boolean" ? result : result.installed;
      if (prepared && !installed) installingUpdate = false;
      return result;
    } catch (error) {
      if (prepared) installingUpdate = false;
      throw error;
    }
  }

  return { start: startDaemon, install };
}
