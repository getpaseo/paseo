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
  /** Re-fires the quit after the user confirms it. */
  quit(): void;
}

interface ExternalQuitSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

interface QuitLifecycle {
  handleBeforeQuit(event: BeforeQuitEvent): void;
  handleBeforeQuitForUpdate(): void;
}

/** The part of the confirmation gate the quit lifecycle depends on. */
export interface QuitConfirmationGate {
  isQuitCommitted(): boolean;
  shouldConfirm(): boolean;
  requestConfirmation(): Promise<boolean>;
  commit(): void;
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
  /**
   * One-shot override from the quit dialog's checkbox. Optional so callers that
   * never show a dialog (tests, and any future headless quit) keep the plain
   * settings-driven behavior.
   */
  keepDaemonRunningThisQuit?: () => boolean;
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
  // Checked before the settings read: the override is the user answering this
  // exact question a second ago, so it outranks the stored preference.
  if (deps.keepDaemonRunningThisQuit?.()) {
    return false;
  }

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
  quitConfirmation,
  onStopError,
  onUpdateError,
}: {
  app: BeforeQuitApp;
  closeTransportSessions: () => void;
  stopDesktopManagedDaemonIfNeeded: () => Promise<boolean>;
  installAppUpdateOnQuit: (signal: AbortSignal) => Promise<boolean>;
  createUpdateDeadlineSignal: () => AbortSignal;
  quitConfirmation: QuitConfirmationGate;
  onStopError: (error: unknown) => void;
  onUpdateError: (error: unknown) => void;
}): QuitLifecycle {
  // The first quit waits for daemon shutdown and update revalidation. A validated
  // update re-fires app.quit(); otherwise app.exit(0) bypasses Electron's macOS
  // window-all-closed handler, which would veto that second quit.
  let quitting = false;
  let quittingForUpdate = false;
  // Only a quit that arrives after we have actually asked the updater to install
  // can be MacUpdater handing off. Before that point a second quit is just the
  // user pressing Cmd+Q again during the multi-second daemon stop, and treating
  // that as handoff evidence would make the app never exit.
  let updateHandoffPossible = false;
  let requitted = false;
  const updateQuit = createDeferredUpdateQuit();

  function handleBeforeQuit(event: BeforeQuitEvent): void {
    // The gate sits above every side effect below. A quit the user is still
    // being asked about must leave transports, window geometry, the daemon and
    // the updater completely untouched.
    if (
      !quitting &&
      !quittingForUpdate &&
      !quitConfirmation.isQuitCommitted() &&
      quitConfirmation.shouldConfirm()
    ) {
      event.preventDefault();
      void quitConfirmation.requestConfirmation().then((confirmed) => {
        // requestConfirmation() dedups concurrent asks, so several vetoed quits
        // can resolve together; only one of them may re-fire the quit.
        if (confirmed && !requitted) {
          requitted = true;
          app.quit();
        }
        return undefined;
      });
      return;
    }

    // Past the gate this quit is happening, so latch it even though nobody was
    // asked. Window geometry flushes from a before-quit listener that gates on
    // this latch, and the quit ends in app.exit(0), which fires neither
    // will-quit nor the window close event. Without this, any quit that skips
    // the dialog (no managed daemon, or keepRunningAfterQuit on) would drop the
    // last resize or move. The flush listener is registered in createWindow,
    // after main.ts registers this handler, so it observes the latch we set here.
    quitConfirmation.commit();

    closeTransportSessions();
    if (quittingForUpdate) return;
    if (quitting) {
      // MacUpdater's no-relaunch path calls app.quit() without emitting
      // before-quit-for-update. A second quit is equivalent handoff evidence,
      // but only once an install is actually under way.
      if (updateHandoffPossible) {
        updateQuit.resolve();
      }
      return;
    }
    quitting = true;
    event.preventDefault();

    void (async () => {
      try {
        await stopDesktopManagedDaemonIfNeeded();
      } catch (error) {
        onStopError(error);
      }

      const signal = createUpdateDeadlineSignal();
      // Armed before the await: quitAndInstall() fires app.quit() from inside
      // this call, so waiting for it to resolve would miss the real handoff.
      updateHandoffPossible = true;
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
      quittingForUpdate = true;
      updateHandoffPossible = true;
      // An update quit is not the user's decision to make; committing here keeps
      // the confirmation dialog out of the install path. One-way dependency:
      // the lifecycle tells the gate, the gate never reads lifecycle state.
      quitConfirmation.commit();
      updateQuit.resolve();
    },
  };
}
