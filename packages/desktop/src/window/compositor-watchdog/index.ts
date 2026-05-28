import { app, type BrowserWindow, powerMonitor } from "electron";

// COMPAT(darwinCompositorWatchdog): added in v0.1.78, target removal after
// 2026-11-19. Workaround for Electron/Chromium macOS display-sleep compositor
// stalls; re-test when Electron/Chromium is upgraded.

// How often the main process probes the renderer for frame production.
const FRAME_PROBE_INTERVAL_MS = 2000;
// A probed frame must arrive within this window or the probe counts as stalled.
const FRAME_PROBE_DEADLINE_MS = 300;
// Consecutive stalled probes before the watchdog restarts the GPU process (~6 s).
const FRAME_STALL_CHECKS_TO_RECOVER = 3;
// Minimum gap between GPU-process restarts.
const COMPOSITOR_RECOVERY_COOLDOWN_MS = 60_000;
// Grace period for Chromium to relaunch the GPU process before probing resumes.
const GPU_RELAUNCH_GRACE_MS = 5_000;
// Stop restarting the GPU process after this many tries without frames returning.
const MAX_CONSECUTIVE_RECOVERIES = 3;

// Resolves { producedFrame, visibilityState } for the renderer. The frame is
// requested with requestAnimationFrame; setTimeout (not vsync-driven) bounds the
// wait so the probe always resolves even when frame production has stopped.
const FRAME_PROBE_SOURCE = `new Promise((resolve) => {
  let settled = false;
  const finish = (producedFrame) => {
    if (settled) return;
    settled = true;
    resolve({ producedFrame, visibilityState: document.visibilityState });
  };
  requestAnimationFrame(() => finish(true));
  setTimeout(() => finish(false), ${FRAME_PROBE_DEADLINE_MS});
})`;

interface FrameStallState {
  stalledChecks: number;
  recovering: boolean;
  msSinceLastRecovery: number;
  consecutiveRecoveries: number;
}

export function shouldRecoverFromFrameStall(state: FrameStallState): boolean {
  return (
    state.stalledChecks >= FRAME_STALL_CHECKS_TO_RECOVER &&
    !state.recovering &&
    state.msSinceLastRecovery >= COMPOSITOR_RECOVERY_COOLDOWN_MS &&
    state.consecutiveRecoveries < MAX_CONSECUTIVE_RECOVERIES
  );
}

function findGpuProcessPid(): number | null {
  for (const metric of app.getAppMetrics()) {
    if (metric.type === "GPU") {
      return metric.pid;
    }
  }
  return null;
}

// macOS display sleep can leave Chromium's GPU-process display link (the vsync
// source that drives frame production) stuck on a stale display. The compositor
// then stops producing frames and the window looks frozen: unresponsive to
// clicks and keys even though the renderer and every process stay alive. This
// watchdog polls the renderer for frame production and, on a sustained stall,
// restarts the GPU process so Chromium rebuilds the display link.
export function setupDarwinCompositorWatchdog(win: BrowserWindow): void {
  if (process.platform !== "darwin") {
    return;
  }

  // Keep producing frames while occluded so the probe is not fooled by throttling.
  win.webContents.setBackgroundThrottling(false);

  let stalledChecks = 0;
  let recovering = false;
  let lastRecoveryAt = 0;
  let consecutiveRecoveries = 0;
  let screenLocked = false;

  const recoverCompositor = async () => {
    recovering = true;
    lastRecoveryAt = Date.now();
    consecutiveRecoveries += 1;
    stalledChecks = 0;
    const gpuPid = findGpuProcessPid();
    console.warn(
      `[compositor-watchdog] Desktop window stopped producing frames; restarting GPU process ` +
        `(pid=${gpuPid ?? "unknown"}, attempt ${consecutiveRecoveries}) to recover`,
    );
    if (gpuPid !== null) {
      try {
        process.kill(gpuPid, "SIGKILL");
      } catch (error) {
        console.warn("[compositor-watchdog] Could not restart GPU process", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, GPU_RELAUNCH_GRACE_MS));
    recovering = false;
  };

  const probeFrameProduction = async () => {
    if (win.isDestroyed() || recovering) {
      return;
    }
    // A freeze is only meaningful, and only distinguishable from a normal idle
    // window, while the window is actually on screen. A locked screen, a
    // minimized window, or a hidden one legitimately stops producing frames.
    if (screenLocked || !win.isVisible() || win.isMinimized()) {
      stalledChecks = 0;
      return;
    }

    let result: { producedFrame?: unknown; visibilityState?: unknown } | null;
    try {
      result = await win.webContents.executeJavaScript(FRAME_PROBE_SOURCE);
    } catch {
      return;
    }
    if (!result || result.visibilityState !== "visible") {
      stalledChecks = 0;
      return;
    }
    if (result.producedFrame === true) {
      stalledChecks = 0;
      consecutiveRecoveries = 0;
      return;
    }

    stalledChecks += 1;
    if (
      shouldRecoverFromFrameStall({
        stalledChecks,
        recovering,
        msSinceLastRecovery: Date.now() - lastRecoveryAt,
        consecutiveRecoveries,
      })
    ) {
      void recoverCompositor();
    }
  };

  const probeTimer = setInterval(() => void probeFrameProduction(), FRAME_PROBE_INTERVAL_MS);
  const handleScreenLocked = () => {
    screenLocked = true;
    stalledChecks = 0;
  };
  const handleScreenUnlocked = () => {
    screenLocked = false;
    stalledChecks = 0;
  };
  powerMonitor.on("lock-screen", handleScreenLocked);
  powerMonitor.on("unlock-screen", handleScreenUnlocked);

  win.once("closed", () => {
    clearInterval(probeTimer);
    powerMonitor.off("lock-screen", handleScreenLocked);
    powerMonitor.off("unlock-screen", handleScreenUnlocked);
  });
}
