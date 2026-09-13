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

type QuitReason = "normal" | "update";

interface QuitLifecycle {
  handleBeforeQuit(event: BeforeQuitEvent): void;
  handleBeforeQuitForUpdate(): void;
}

interface DeferredUpdateQuit {
  promise: Promise<boolean>;
  resolve(): void;
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

/**
 * Determines whether the daemon should be stopped on quit.
 *
 * During an update quit, the daemon is always stopped (regardless of user
 * setting) to release file handles before the installer runs. During a
 * normal quit, the user's `keepRunningAfterQuit` preference is respected.
 */
export function shouldStopDesktopManagedDaemonOnQuit(
  settings: QuitLifecycleSettings,
  reason: QuitReason,
): boolean {
  if (reason === "update") {
    return true;
  }
  return !settings.daemon.keepRunningAfterQuit;
}

export async function stopDesktopManagedDaemonOnQuitIfNeeded(
  deps: StopOnQuitDeps,
  reason: QuitReason = "normal",
): Promise<boolean> {
  const settings = await deps.settingsStore.get();
  if (!shouldStopDesktopManagedDaemonOnQuit(settings, reason)) {
    return false;
  }

  if (!deps.isDesktopManagedDaemonRunning()) {
    return false;
  }

  deps.showShutdownFeedback();
  await deps.stopDaemon();
  return true;
}

function waitForUpdateDeadline(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
}

function createDeferredUpdateQuit(): DeferredUpdateQuit {
  let resolvePromise!: (started: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise(true) };
}

export function createQuitLifecycle({
  app,
  closeTransportSessions,
  stopDesktopManagedDaemonIfNeeded,
  installAppUpdateOnQuit,
  createUpdateDeadlineSignal,
  onStopError,
  onUpdateError,
}: {
  app: BeforeQuitApp;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: (reason: QuitReason) => Promise<boolean>;
  installAppUpdateOnQuit: (signal: AbortSignal) => Promise<boolean>;
  createUpdateDeadlineSignal: () => AbortSignal;
  onStopError: (error: unknown) => void;
  onUpdateError: (error: unknown) => void;
}): QuitLifecycle {
  // The first quit waits for daemon shutdown and update revalidation. A validated
  // update re-fires app.quit(); otherwise app.exit(0) bypasses Electron's macOS
  // window-all-closed handler, which would veto that second quit.
  let quitting = false;
  let quitReason: QuitReason = "normal";
  const updateQuit = createDeferredUpdateQuit();

  function handleBeforeQuit(event: BeforeQuitEvent): void {
    closeTransportSessions();
    if (quitting) {
      // MacUpdater's no-relaunch path calls app.quit() without emitting
      // before-quit-for-update. A second quit is equivalent handoff evidence.
      updateQuit.resolve();
      return;
    }
    quitting = true;
    event.preventDefault();

    void (async () => {
      try {
        await stopDesktopManagedDaemonIfNeeded(quitReason);
      } catch (error) {
        onStopError(error);
      }

      const signal = createUpdateDeadlineSignal();
      const updateInstallation = installAppUpdateOnQuit(signal).catch((error) => {
        onUpdateError(error);
        return false;
      });
      const installingUpdate = await Promise.race([
        updateInstallation,
        waitForUpdateDeadline(signal),
      ]);
      if (installingUpdate) {
        const handoffStarted = await Promise.race([
          updateQuit.promise,
          waitForUpdateDeadline(createUpdateDeadlineSignal()),
        ]);
        if (handoffStarted) {
          return;
        }
      }

      app.exit(0);
    })();
  }

  return {
    handleBeforeQuit,
    handleBeforeQuitForUpdate() {
      quitReason = "update";
      updateQuit.resolve();
    },
  };
}
