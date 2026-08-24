/**
 * Decides whether closing a window should be vetoed to ask the user first.
 *
 * On Windows and Linux there is no Cmd+Q — closing the last window is how people
 * quit, and `window-all-closed` turns that into `app.quit()`. So the guard has to
 * sit on the window close, not only on `before-quit`.
 *
 * Pure and Electron-free on purpose: the window enumeration is the subtle part
 * (the closing window still counts itself, destroyed-but-uncollected windows
 * linger, and detached DevTools windows are BrowserWindows too), so it lives
 * inside the tested unit rather than at the call site in main.ts.
 */

interface CloseableWindow {
  isDestroyed(): boolean;
}

export interface WindowCloseDecisionInput {
  /** Every window the app currently owns, including the one being closed. */
  windows: CloseableWindow[];
  /** True once the quit has been confirmed or handed to the auto-updater. */
  quitCommitted: boolean;
  /** True while the OS is logging out or shutting down. */
  sessionEnding: boolean;
}

/** Windows that still count toward "is this the last one". */
export function countLiveWindows(windows: CloseableWindow[]): number {
  return windows.filter((win) => !win.isDestroyed()).length;
}

export function shouldVetoWindowClose({
  windows,
  quitCommitted,
  sessionEnding,
}: WindowCloseDecisionInput): boolean {
  // The user already answered, or `quitAndInstall()` is closing every window to
  // install an update. Vetoing here would strand the updater mid-handoff.
  if (quitCommitted) {
    return false;
  }

  // Windows delivers WM_QUERYENDSESSION/WM_CLOSE during logout. Vetoing either
  // parks the shutdown behind a "this app is preventing you from logging out"
  // dialog or gets the process force-killed with the dialog still up.
  if (sessionEnding) {
    return false;
  }

  // Closing one of several windows doesn't quit the app, so there is nothing to
  // confirm. Only the last one turns into a quit.
  //
  // `<= 1` rather than `=== 1` deliberately: whether the closing window is still
  // in getAllWindows() during its own `close` event is an Electron implementation
  // detail, and both readings (1 = it counts itself, 0 = already removed) mean no
  // window survives. The dialog falls back to app-modal when no window is usable,
  // so the 0 case still shows something.
  return countLiveWindows(windows) <= 1;
}
