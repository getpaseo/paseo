/**
 * Confirmation gate for quitting the desktop app.
 *
 * Quitting is irreversible and, in the default configuration, stops the
 * desktop-managed daemon and with it every running agent. This module decides
 * whether a given quit needs a confirmation dialog and owns the "committed"
 * latch that every other quit-path guard reads.
 *
 * Deliberately free of Electron imports so the whole decision table is
 * unit-testable; `main.ts` supplies the Electron-shaped dependencies.
 */

export interface QuitConfirmationCopy {
  title: string;
  message: string;
  quitLabel: string;
  cancelLabel: string;
  keepDaemonRunningLabel: string;
}

export interface QuitConfirmationDialogResult {
  confirmed: boolean;
  /**
   * The checkbox. Applies to this quit only and is never written to settings —
   * "keep it running just this once" and "keep it running from now on" are
   * different intents, and the durable one lives in Settings.
   */
  keepDaemonRunning: boolean;
}

/** The slice of DesktopSettings this gate reads. */
export interface QuitConfirmationSettings {
  daemon: {
    keepRunningAfterQuit: boolean;
  };
}

export interface QuitConfirmationDeps {
  /**
   * Synchronous because the caller has to decide before `event.preventDefault()`.
   * Returns null when settings have not loaded yet, which reads as "don't veto".
   */
  readSettingsSync: () => QuitConfirmationSettings | null;
  isAppReady: () => boolean;
  hasOpenWindows: () => boolean;
  isDesktopManagedDaemonRunning: () => boolean;
  loadCopy: () => QuitConfirmationCopy;
  showDialog: (copy: QuitConfirmationCopy) => Promise<QuitConfirmationDialogResult>;
  onError: (error: unknown) => void;
}

export interface QuitConfirmation {
  /** True once the quit has been confirmed, or handed off to the updater. */
  isQuitCommitted(): boolean;
  /** Marks the quit as committed without asking. Used by the auto-update path. */
  commit(): void;
  /** Whether this quit needs a dialog. Synchronous by contract. */
  shouldConfirm(): boolean;
  /** Shows the dialog (at most one at a time) and resolves to the user's answer. */
  requestConfirmation(): Promise<boolean>;
  /**
   * True when the user ticked "leave daemon running" for the quit now in
   * progress. Read by the stop-on-quit step, which runs after the re-fired
   * quit, so the answer has to outlive the dialog that produced it.
   */
  shouldKeepDaemonRunningThisQuit(): boolean;
}

interface DialogParentWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
}

/**
 * Picks the window to parent the dialog to.
 *
 * On macOS a message box parented to a hidden (Cmd+H) or minimized window renders
 * as a sheet on a window nobody can see, so the app just appears to hang on quit.
 * Returning null makes it an app-modal dialog instead, which is always visible.
 */
export function selectDialogParentWindow<T extends DialogParentWindow>(windows: T[]): T | null {
  const candidates = windows.filter(
    (win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
  );
  return candidates.find((win) => win.isFocused()) ?? candidates[0] ?? null;
}

export function createQuitConfirmation(deps: QuitConfirmationDeps): QuitConfirmation {
  let committed = false;
  let pending: Promise<boolean> | null = null;
  let keepDaemonRunningThisQuit = false;

  function shouldConfirm(): boolean {
    if (committed) {
      return false;
    }

    // A quit before the app is up (the second-instance lock calls app.quit()
    // during startup) has no window to parent a dialog to and nothing at stake.
    if (!deps.isAppReady() || !deps.hasOpenWindows()) {
      return false;
    }

    try {
      const settings = deps.readSettingsSync();
      if (!settings) {
        return false;
      }
      // Only prompt when quitting will actually stop a running daemon. Without
      // this the dialog fires on quits with nothing at stake, which is how a
      // confirmation prompt trains people to dismiss it reflexively.
      //
      // This is also the only way to switch the prompt off: "Keep daemon running
      // after quit" silences it and removes the risk, which is strictly better
      // than a separate toggle that silences it and leaves the risk.
      if (settings.daemon.keepRunningAfterQuit) {
        return false;
      }
      return deps.isDesktopManagedDaemonRunning();
    } catch (error) {
      deps.onError(error);
      return false;
    }
  }

  async function runConfirmation(): Promise<boolean> {
    try {
      const result = await deps.showDialog(deps.loadCopy());
      if (!result.confirmed) {
        // A ticked checkbox alongside Cancel decides nothing: there is no quit
        // for it to apply to. Carrying it to a later quit would be the worst
        // possible reading of "no, don't quit".
        return false;
      }
      keepDaemonRunningThisQuit = result.keepDaemonRunning;
      committed = true;
      return true;
    } catch (error) {
      // Fail open. A rejection here leaves the quit already preventDefault()ed
      // with nothing left to re-fire it, i.e. an app that can only be killed by
      // Force Quit — exactly the ungraceful exit this feature exists to prevent.
      deps.onError(error);
      committed = true;
      return true;
    }
  }

  return {
    isQuitCommitted: () => committed,

    commit(): void {
      committed = true;
    },

    shouldConfirm,

    shouldKeepDaemonRunningThisQuit: () => keepDaemonRunningThisQuit,

    async requestConfirmation(): Promise<boolean> {
      if (committed) {
        return true;
      }
      // Cmd+Q while the dialog is already open, and the close-veto and
      // before-quit paths both firing for one quit, must share one dialog.
      if (pending) {
        return pending;
      }
      pending = runConfirmation().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
