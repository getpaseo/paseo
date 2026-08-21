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

// A battery level the renderer never resolved, doesn't support, or that
// rejected must be treated as "possibly below the cutoff", not "safe" — an
// unknown reading is exactly the stale/buggy-signal case this safety net
// exists for, so it must fail closed rather than fail open.
export function computeKeepAwakeState(request: KeepAwakeRequest): KeepAwakeState {
  const batteryKnownSafe =
    request.batteryLevel !== null && request.batteryLevel >= LOW_BATTERY_CUTOFF;
  return {
    active: request.enabled && batteryKnownSafe,
    suppressedByLowBattery: request.enabled && !batteryKnownSafe,
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

// Desktop supports multiple windows sharing this one command-handler instance
// (registered once at startup), so state is tracked per sender rather than as
// a single last-write-wins value: any window reporting a running agent holds
// the block, and the most conservative (lowest) known battery reading wins.
// A sender's entry is dropped as soon as its WebContents goes away — closed,
// reloaded away, or crashed — so a window that disappears can never keep the
// block held on its own say after nothing is left to report otherwise.
function aggregateKeepAwakeRequests(requests: Iterable<KeepAwakeRequest>): KeepAwakeRequest {
  let enabled = false;
  let batteryLevel: number | null = null;
  for (const request of requests) {
    enabled = enabled || request.enabled;
    if (request.batteryLevel !== null) {
      batteryLevel =
        batteryLevel === null ? request.batteryLevel : Math.min(batteryLevel, request.batteryLevel);
    }
  }
  return { enabled, batteryLevel };
}

interface KeepAwakeSender {
  id: number;
  isDestroyed(): boolean;
  once(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
}

export function createKeepAwakeCommandHandlers(): Record<string, DesktopCommandHandler> {
  let blockerId: number | null = null;
  const requestsBySenderId = new Map<number, KeepAwakeRequest>();
  const trackedSenderIds = new Set<number>();

  function sync(): KeepAwakeState {
    const state = computeKeepAwakeState(aggregateKeepAwakeRequests(requestsBySenderId.values()));
    if (state.active && blockerId === null) {
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!state.active && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    return state;
  }

  function trackSender(sender: KeepAwakeSender): void {
    if (trackedSenderIds.has(sender.id) || sender.isDestroyed()) {
      return;
    }
    trackedSenderIds.add(sender.id);
    const forget = () => {
      requestsBySenderId.delete(sender.id);
      trackedSenderIds.delete(sender.id);
      sync();
    };
    sender.once("destroyed", forget);
    sender.once("render-process-gone", forget);
  }

  return {
    desktop_set_keep_awake: (args, event) => {
      const sender = event?.sender as KeepAwakeSender | undefined;
      if (sender) {
        requestsBySenderId.set(sender.id, parseKeepAwakeRequest(args));
        trackSender(sender);
      }
      return sync();
    },
  };
}
