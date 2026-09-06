import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { hasDaemonReconnectedAfter, type DaemonConnectionSnapshot } from "./daemon-reconnect";

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

async function isLocalDesktopManagedDaemon(
  hostServerId: string,
  deps: SettingsDaemonRestartDeps,
): Promise<boolean> {
  if (!deps.getIsElectron()) {
    return false;
  }

  const desktopDaemonStatus = await deps.getDesktopDaemonStatus();
  if (!desktopDaemonStatus.desktopManaged) {
    return false;
  }

  const normalizedHostServerId = hostServerId.trim();
  const normalizedDesktopServerId = desktopDaemonStatus.serverId.trim();

  if (normalizedHostServerId.length === 0 || normalizedHostServerId !== normalizedDesktopServerId) {
    return false;
  }

  const desktopSettings = await deps.getDesktopSettings();
  return desktopSettings.daemon.manageBuiltInDaemon;
}

export async function restartDaemonFromSettings(
  hostServerId: string,
  reason: string,
  deps: SettingsDaemonRestartDeps,
): Promise<void> {
  if (await isLocalDesktopManagedDaemon(hostServerId, deps)) {
    await deps.restartDesktopDaemon();
    return;
  }

  await deps.restartServer(reason);
}

export async function restartDaemonAndWaitForReconnect(input: {
  restart: () => Promise<unknown>;
  getSnapshot: () => DaemonConnectionSnapshot | null;
  subscribe: (listener: () => void) => () => void;
  timeoutMs?: number;
}): Promise<void> {
  const start = input.getSnapshot();
  const timeoutMs = input.timeoutMs ?? 60_000;
  let unsubscribe: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const reconnected = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!hasDaemonReconnectedAfter(input.getSnapshot(), start)) return;
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    unsubscribe = input.subscribe(check);
    timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Daemon did not reconnect after restart"));
    }, timeoutMs);
    check();
  });

  try {
    await input.restart();
  } catch (error) {
    const snapshot = input.getSnapshot();
    if (snapshot?.connectionStatus === "online" && !hasDaemonReconnectedAfter(snapshot, start)) {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
      void reconnected.catch(() => undefined);
      throw error;
    }
  }
  await reconnected;
}
