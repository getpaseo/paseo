import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

interface DesktopDaemonRestartStatus {
  desktopManaged: boolean;
  serverId: string;
}

interface DesktopDaemonRestartSettings {
  daemon: {
    manageBuiltInDaemon: boolean;
  };
}

export interface SettingsDaemonRestartDeps {
  getIsElectron: () => boolean;
  getDesktopDaemonStatus: () => Promise<DesktopDaemonRestartStatus>;
  getDesktopSettings: () => Promise<DesktopDaemonRestartSettings>;
  restartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  restartServer: (reason: string) => Promise<unknown>;
}

export function isLocalDesktopManagedDaemon(
  hostServerId: string,
  desktopDaemonStatus: DesktopDaemonRestartStatus,
  desktopSettings: DesktopDaemonRestartSettings,
  isElectron: boolean,
): boolean {
  if (
    !isElectron ||
    !desktopDaemonStatus.desktopManaged ||
    !desktopSettings.daemon.manageBuiltInDaemon
  ) {
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
    const [desktopDaemonStatus, desktopSettings] = await Promise.all([
      deps.getDesktopDaemonStatus(),
      deps.getDesktopSettings(),
    ]);
    if (
      isLocalDesktopManagedDaemon(hostServerId, desktopDaemonStatus, desktopSettings, isElectron)
    ) {
      await deps.restartDesktopDaemon();
      return;
    }
  }

  await deps.restartServer(reason);
}
