import { type BrowserWindow, powerMonitor } from "electron";

// COMPAT(darwinInputWatchdog): added in v0.18.2, target removal after
// 2027-05-28. Workaround for Electron/Chromium macOS input-pipe wedge
// (electron/electron#53529); re-test when Electron/Chromium is upgraded.

// How often the main process sends a canary input event and checks delivery.
const INPUT_PROBE_INTERVAL_MS = 2000;
// Consecutive undelivered canaries before the watchdog reloads the renderer.
const MISSED_CHECKS_TO_RECOVER = 2;
// Minimum gap between recoveries.
const INPUT_RECOVERY_COOLDOWN_MS = 30_000;
// Stop reloading after this many tries without input coming back. The user can
// always recover manually with Cmd+R.
const MAX_CONSECUTIVE_RECOVERIES = 3;

// Canary coordinates cycle through a small offset pattern so Chromium cannot
// coalesce consecutive synthetic moves into one event.
const CANARY_OFFSETS = [
  [12, 12],
  [17, 12],
  [17, 17],
  [12, 17],
] as const;

// Installs the renderer-side counter for trusted input events. Synthetic
// sendInputEvent events are trusted, as are real user events; untrusted
// scripted events are ignored. mouseMove is used as the canary because it
// cannot mutate app state the way a synthetic key or click could.
const INSTALL_PROBE_SOURCE = `(() => {
  if (window.__paseoInputProbe) return;
  const probe = { seen: 0 };
  window.__paseoInputProbe = probe;
  document.addEventListener("mousemove", (event) => {
    if (event.isTrusted) probe.seen += 1;
  }, { capture: true, passive: true });
})()`;

const READ_PROBE_SOURCE = "window.__paseoInputProbe ? window.__paseoInputProbe.seen : null";

export interface InputWedgeState {
  missedChecks: number;
  recovering: boolean;
  msSinceLastRecovery: number;
  consecutiveRecoveries: number;
}

export function shouldRecoverFromInputWedge(state: InputWedgeState): boolean {
  return (
    state.missedChecks >= MISSED_CHECKS_TO_RECOVER &&
    !state.recovering &&
    state.msSinceLastRecovery >= INPUT_RECOVERY_COOLDOWN_MS &&
    state.consecutiveRecoveries < MAX_CONSECUTIVE_RECOVERIES
  );
}

// After an acknowledged probe the counter is caught up and the miss streak
// clears; after an unacknowledged one it grows.
export function recordProbeResult(missedChecks: number, acknowledged: boolean): number {
  return acknowledged ? 0 : missedChecks + 1;
}

// After an app switch the Chromium mojo WidgetInputHandler pipe can wedge: the
// browser process forwards input but the renderer never receives it, so the
// window ignores all mouse and keyboard input while the renderer itself stays
// healthy. This watchdog injects a synthetic mouseMove canary and verifies the
// renderer saw it over the (separate) JS evaluation channel. When canaries go
// undelivered while the window is visible and focused, it reloads the
// renderer, which reliably unwedges the input path.
export function setupDarwinInputWatchdog(win: BrowserWindow): void {
  if (process.platform !== "darwin") {
    return;
  }
  if (process.env.PASEO_DISABLE_INPUT_WATCHDOG === "1") {
    return;
  }

  let missedChecks = 0;
  let recovering = false;
  let lastRecoveryAt = 0;
  let consecutiveRecoveries = 0;
  let canaryIndex = 0;
  let expectedSeen = 0;
  let screenLocked = false;

  const installProbe = async () => {
    if (win.isDestroyed()) {
      return;
    }
    try {
      await win.webContents.executeJavaScript(INSTALL_PROBE_SOURCE);
      const seen = await win.webContents.executeJavaScript(READ_PROBE_SOURCE);
      if (typeof seen === "number") {
        expectedSeen = seen;
        missedChecks = 0;
      }
    } catch {
      // The renderer may be mid-navigation; the next did-finish-load retries.
    }
    // Probing resumes only once the fresh renderer has its probe installed.
    recovering = false;
  };

  const recoverInputPipe = () => {
    recovering = true;
    lastRecoveryAt = Date.now();
    consecutiveRecoveries += 1;
    missedChecks = 0;
    console.warn(
      `[input-watchdog] Renderer stopped receiving input while the window was ` +
        `visible and focused; reloading it to unwedge the input pipe ` +
        `(attempt ${consecutiveRecoveries})`,
    );
    win.webContents.reload();
  };

  const probeInputDelivery = async () => {
    if (win.isDestroyed() || recovering) {
      return;
    }
    // A missed canary is only meaningful while the window is on screen and
    // receiving focus; a hidden, minimized, or unfocused window legitimately
    // does not process input.
    if (screenLocked || !win.isVisible() || win.isMinimized() || !win.isFocused()) {
      missedChecks = 0;
      return;
    }

    let seen: number | null;
    try {
      seen = await win.webContents.executeJavaScript(READ_PROBE_SOURCE);
    } catch {
      return;
    }
    if (typeof seen !== "number") {
      return;
    }

    const acknowledged = seen >= expectedSeen;
    missedChecks = recordProbeResult(missedChecks, acknowledged);
    expectedSeen = seen + 1;

    const [xOffset, yOffset] = CANARY_OFFSETS[canaryIndex % CANARY_OFFSETS.length];
    canaryIndex += 1;
    const [width, height] = win.getContentSize();
    win.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.min(width - 1, xOffset),
      y: Math.min(height - 1, yOffset),
    });

    if (
      shouldRecoverFromInputWedge({
        missedChecks,
        recovering,
        msSinceLastRecovery: Date.now() - lastRecoveryAt,
        consecutiveRecoveries,
      })
    ) {
      recoverInputPipe();
    }
  };

  const handleDidFinishLoad = () => void installProbe();
  win.webContents.on("did-finish-load", handleDidFinishLoad);
  const probeTimer = setInterval(() => void probeInputDelivery(), INPUT_PROBE_INTERVAL_MS);
  const handleScreenLocked = () => {
    screenLocked = true;
    missedChecks = 0;
  };
  const handleScreenUnlocked = () => {
    screenLocked = false;
    missedChecks = 0;
  };
  powerMonitor.on("lock-screen", handleScreenLocked);
  powerMonitor.on("unlock-screen", handleScreenUnlocked);

  win.once("closed", () => {
    clearInterval(probeTimer);
    win.webContents.off("did-finish-load", handleDidFinishLoad);
    powerMonitor.off("lock-screen", handleScreenLocked);
    powerMonitor.off("unlock-screen", handleScreenUnlocked);
  });
}
