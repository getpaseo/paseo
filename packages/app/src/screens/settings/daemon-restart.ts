import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

type DesktopDaemonRestartStatus = Pick<DesktopDaemonStatus, "desktopManaged" | "serverId">;

export interface SettingsDaemonRestartDeps {
  getIsElectron: () => boolean;
  getDesktopDaemonStatus: () => Promise<DesktopDaemonRestartStatus>;
  restartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  restartServer: (reason: string) => Promise<unknown>;
}

export function isLocalDesktopManagedDaemon(
  hostServerId: string,
  desktopDaemonStatus: DesktopDaemonRestartStatus,
  isElectron: boolean,
): boolean {
  if (!isElectron || !desktopDaemonStatus.desktopManaged) {
    return false;
  }

  const normalizedHostServerId = hostServerId.trim();
  const normalizedDesktopServerId = desktopDaemonStatus.serverId.trim();

  return normalizedHostServerId.length > 0 && normalizedHostServerId === normalizedDesktopServerId;
}

export async function restartDaemonFromSettings(
  hostServerId: string,
  reason: string,
  deps: SettingsDaemonRestartDeps,
): Promise<void> {
  const isElectron = deps.getIsElectron();

  if (isElectron) {
    const desktopDaemonStatus = await deps.getDesktopDaemonStatus();
    if (isLocalDesktopManagedDaemon(hostServerId, desktopDaemonStatus, isElectron)) {
      await deps.restartDesktopDaemon();
      return;
    }
  }

  await deps.restartServer(reason);
}
