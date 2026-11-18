import log from "electron-log/main";

// A window whose renderer exits keeps its frame but shows nothing until it is
// reloaded. Reload it, but stop when the renderer keeps exiting so a page that
// crashes on load does not restart in a loop.
const MAX_RELOADS_PER_WINDOW = 3;
const RELOAD_WINDOW_MS = 60_000;

interface RendererExit {
  reason: string;
  exitCode: number;
}

interface RecoverableWindow {
  isDestroyed(): boolean;
  webContents: {
    on(
      event: "render-process-gone",
      listener: (event: unknown, details: RendererExit) => void,
    ): unknown;
    getURL(): string;
    reload(): void;
  };
}

export function reloadWhenRendererExits(
  win: RecoverableWindow,
  options: { now?: () => number } = {},
): void {
  const now = options.now ?? Date.now;
  let reloadTimes: number[] = [];

  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    // Before the first page commits, Chromium finishes the navigation in a new
    // renderer by itself. Reloading then would abort the window's initial load.
    if (win.webContents.getURL() === "") return;

    const time = now();
    reloadTimes = reloadTimes.filter((reloadTime) => time - reloadTime < RELOAD_WINDOW_MS);
    if (reloadTimes.length >= MAX_RELOADS_PER_WINDOW) {
      log.error(
        `[renderer-recovery] Renderer exited (${details.reason}, code ${details.exitCode}); ` +
          `not reloading after ${reloadTimes.length} reloads in the last minute`,
      );
      return;
    }

    reloadTimes.push(time);
    log.warn(
      `[renderer-recovery] Renderer exited (${details.reason}, code ${details.exitCode}); ` +
        `reloading the window (reload ${reloadTimes.length} in the last minute)`,
    );
    win.webContents.reload();
  });
}
