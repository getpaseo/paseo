// COMPAT(readyToShowFallback): added in v0.7.0, re-test on every Electron upgrade,
// remove after 2027-03-01. On Wayland (observed on ChromeOS Linux, Electron 41) a
// BrowserWindow created with `show: false` can sit forever without producing a
// single compositor frame: the renderer loads and runs, but never gets a
// BeginFrame, so "ready-to-show" never fires and the window is never shown.
// The app then looks like it did not start at all while every process is alive.

// How long to wait for "ready-to-show" before showing the window regardless.
// Normal startups fire the event well inside this on a cold ARM machine.
export const LINUX_READY_TO_SHOW_FALLBACK_MS = 2_000;

export interface ReadyToShowWindow {
  once(event: "ready-to-show" | "closed", listener: () => void): unknown;
  show(): void;
  isDestroyed(): boolean;
}

export interface ShowWindowWhenReadyOptions {
  // `null` disables the fallback and only reacts to "ready-to-show".
  fallbackMs: number | null;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

// Shows `win` on "ready-to-show", or after `fallbackMs` if the event never
// arrives. Shows at most once and never after the window closed.
export function showWindowWhenReady(
  win: ReadyToShowWindow,
  options: ShowWindowWhenReadyOptions,
): void {
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  let shown = false;
  let fallback: ReturnType<typeof setTimeout> | null = null;

  const show = () => {
    if (fallback !== null) {
      clearTimeoutImpl(fallback);
      fallback = null;
    }
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };

  win.once("ready-to-show", show);
  if (options.fallbackMs !== null) {
    fallback = setTimeoutImpl(show, options.fallbackMs);
  }
  win.once("closed", () => {
    shown = true;
    if (fallback !== null) {
      clearTimeoutImpl(fallback);
      fallback = null;
    }
  });
}
