import type { DesktopSettingsStore } from "../settings/desktop-settings.js";

interface QuitLifecycleSettings {
  daemon: {
    keepRunningAfterQuit: boolean;
  };
}

interface BeforeQuitEvent {
  preventDefault(): void;
}

interface BeforeQuitApp {
  exit(code: number): void;
}

export interface StopOnQuitDeps {
  settingsStore: Pick<DesktopSettingsStore, "get">;
  isDesktopManagedDaemonRunning: () => boolean;
  stopDaemon: () => Promise<unknown>;
  showShutdownFeedback: () => void;
}

export function shouldStopDesktopManagedDaemonOnQuit(settings: QuitLifecycleSettings): boolean {
  return !settings.daemon.keepRunningAfterQuit;
}

export async function stopDesktopManagedDaemonOnQuitIfNeeded(
  deps: StopOnQuitDeps,
): Promise<boolean> {
  const settings = await deps.settingsStore.get();
  if (!shouldStopDesktopManagedDaemonOnQuit(settings)) {
    return false;
  }

  if (!deps.isDesktopManagedDaemonRunning()) {
    return false;
  }

  deps.showShutdownFeedback();
  await deps.stopDaemon();
  return true;
}

export function createBeforeQuitHandler({
  app,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  installAppUpdateOnQuit,
  onStopError,
  onUpdateError,
}: {
  app: BeforeQuitApp;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: () => Promise<boolean>;
  installAppUpdateOnQuit: () => Promise<boolean>;
  onStopError: (error: unknown) => void;
  onUpdateError: (error: unknown) => void;
}): (event: BeforeQuitEvent) => void {
  // The first quit waits for daemon shutdown and update revalidation. A validated
  // update re-fires app.quit(); otherwise app.exit(0) bypasses Electron's macOS
  // window-all-closed handler, which would veto that second quit.
  let quitting = false;

  return (event) => {
    closeTransportSessions();
    if (quitting) return;
    quitting = true;
    event.preventDefault();

    void (async () => {
      try {
        await stopDesktopManagedDaemonIfNeeded();
      } catch (error) {
        onStopError(error);
      }

      try {
        const installingUpdate = await installAppUpdateOnQuit();
        if (installingUpdate) {
          return;
        }
      } catch (error) {
        onUpdateError(error);
      }

      app.exit(0);
    })();
  };
}
