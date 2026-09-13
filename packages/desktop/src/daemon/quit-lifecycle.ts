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

interface ExternalQuitSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

interface QuitLifecycle {
  handleBeforeQuit(event: BeforeQuitEvent): void;
}

export interface StopOnQuitDeps {
  settingsStore: Pick<DesktopSettingsStore, "get">;
  isDesktopManagedDaemonRunning: () => boolean;
  stopDaemon: () => Promise<unknown>;
  showShutdownFeedback: () => void;
}

export function registerExternalQuitSignals({
  signals,
  quit,
}: {
  signals: ExternalQuitSignalSource;
  quit: () => void;
}): void {
  let quitRequested = false;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
    signals.on(signal, () => {
      if (quitRequested) return;
      quitRequested = true;
      quit();
    });
  }
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

export function createQuitLifecycle({
  app,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  onStopError,
}: {
  app: BeforeQuitApp;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: () => Promise<boolean>;
  onStopError: (error: unknown) => void;
}): QuitLifecycle {
  // The first quit waits for daemon shutdown; app.exit(0) then bypasses
  // Electron's macOS window-all-closed handler, which would veto a second quit.
  let quitting = false;

  function handleBeforeQuit(event: BeforeQuitEvent): void {
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

      app.exit(0);
    })();
  }

  return { handleBeforeQuit };
}
