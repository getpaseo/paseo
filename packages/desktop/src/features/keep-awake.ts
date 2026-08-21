import { powerSaveBlocker } from "electron";
import type { DesktopCommandHandler } from "../settings/desktop-settings-commands.js";

// The renderer is the only place that knows both "is any agent running" (daemon
// session state) and the battery level (Chromium's navigator.getBattery()) —
// Electron's main process has no battery API of its own. The renderer reports
// both on every change; the main process re-derives whether to hold the block
// itself so a stale or buggy renderer signal can never keep the block held.
const LOW_BATTERY_CUTOFF = 0.1;

export interface KeepAwakeRequest {
  enabled: boolean;
  batteryLevel: number | null;
}

export interface KeepAwakeState {
  active: boolean;
  suppressedByLowBattery: boolean;
}

export function computeKeepAwakeState(request: KeepAwakeRequest): KeepAwakeState {
  const suppressedByLowBattery =
    request.batteryLevel !== null && request.batteryLevel < LOW_BATTERY_CUTOFF;
  return {
    active: request.enabled && !suppressedByLowBattery,
    suppressedByLowBattery,
  };
}

function parseKeepAwakeRequest(args: Record<string, unknown> | undefined): KeepAwakeRequest {
  const enabled = args?.enabled === true;
  const rawBatteryLevel = args?.batteryLevel;
  const batteryLevel =
    typeof rawBatteryLevel === "number" && Number.isFinite(rawBatteryLevel)
      ? rawBatteryLevel
      : null;
  return { enabled, batteryLevel };
}

export function createKeepAwakeCommandHandlers(): Record<string, DesktopCommandHandler> {
  let blockerId: number | null = null;

  function sync(state: KeepAwakeState): KeepAwakeState {
    if (state.active && blockerId === null) {
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!state.active && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    return state;
  }

  return {
    desktop_set_keep_awake: (args) => sync(computeKeepAwakeState(parseKeepAwakeRequest(args))),
  };
}
