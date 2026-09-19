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

const DEFAULT_FLUSH_PENDING_UPDATE_DEADLINE_MS = 2_000;

export function createQuitLifecycle({
  app,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  flushPendingUpdate,
  flushDeadlineMs,
  onStopError,
  onFlushError,
}: {
  app: BeforeQuitApp;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: () => Promise<boolean>;
  /**
   * Waits for an in-flight pending-update marker write to settle. Injected so
   * this module stays unaware of the updater; the quit path must not drop a
   * marker recorded just before exit.
   */
  flushPendingUpdate?: () => Promise<void>;
  flushDeadlineMs?: number;
  onStopError: (error: unknown) => void;
  onFlushError: (error: unknown) => void;
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

      // A stalled marker write must never block quitting, so the flush is
      // bounded by a deadline. flushPendingUpdate promises never to reject;
      // onFlushError covers an unexpected violation of that contract.
      let flushTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          flushPendingUpdate?.().catch((error) => onFlushError(error)),
          new Promise<void>((resolve) => {
            flushTimer = setTimeout(
              resolve,
              flushDeadlineMs ?? DEFAULT_FLUSH_PENDING_UPDATE_DEADLINE_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(flushTimer);
      }

      app.exit(0);
    })();
  }

  return { handleBeforeQuit };
}
