/**
 * `PerfMonitor` — the host-drawn performance overlay.
 *
 * The overlay is painted by GPUI above every surface, so it never competes with
 * what it measures. JS only toggles it and reports its own frame rate.
 *
 * @format
 */

import NativeGpuiPerfMonitor from '../specs/NativeGpuiPerfMonitor';
import { nativeRequest } from './index';

/** Runs one GpuiPerfMonitor method with the shared module check. */
function request<T>(
  run: (native: NonNullable<typeof NativeGpuiPerfMonitor>) => Promise<T>,
): Promise<T> {
  return nativeRequest('GpuiPerfMonitor', check =>
    run(check(NativeGpuiPerfMonitor)),
  );
}

export interface PerfMetrics {
  enabled: boolean;
  uiFps: number;
  /** Tasks the JS thread ran in the last second, one posted per frame. */
  jsFps: number;
  memoryBytes: number;
  /** Bytes the JS engine reports as allocated; 0 when it does not say. */
  jsHeapBytes: number;
  /** Display refreshes without a new frame since the monitor was enabled. */
  droppedFrames: number;
  /** Times four or more frames dropped in a row. */
  stutters: number;
  mountedViews: number;
  lastMountMs: number;
}

let nativeBridgeInstalled = false;

function installNativeBridge(): void {
  if (nativeBridgeInstalled) {
    return;
  }
  nativeBridgeInstalled = true;
  // Resolved lazily: the desktop entry loads this module while `react-native`
  // is still initializing, and the package's exports are not populated yet.
  const { DeviceEventEmitter } = require('react-native');
  DeviceEventEmitter.addListener(
    'gpuiDesktop:perfMonitor',
    (event: { enabled?: boolean }) => {
      if (event?.enabled) {
        startJsTicker();
      } else {
        stopJsTicker();
      }
    },
  );
}

export function installPerfMonitorBridge(): void {
  installNativeBridge();
}

// JS FPS is measured natively: the host posts a task to the JS thread each
// frame and counts the ones that ran. A counter in JS would add work to the
// thread it measures, and could not report while that thread is busy.
function startJsTicker(): void {}

function stopJsTicker(): void {}

export const PerfMonitor = {
  async setEnabled(enabled: boolean): Promise<boolean> {
    const result = await request(native =>
      native.perfMonitorSetEnabled(enabled),
    );
    if (result.enabled) {
      startJsTicker();
    } else {
      stopJsTicker();
    }
    return result.enabled;
  },

  async isEnabled(): Promise<boolean> {
    const metrics = await PerfMonitor.getMetrics();
    return metrics.enabled;
  },

  getMetrics(): Promise<PerfMetrics> {
    return request(native =>
      native.perfMonitorGetMetrics(),
    ) as Promise<PerfMetrics>;
  },

  async toggle(): Promise<boolean> {
    const enabled = await PerfMonitor.isEnabled();
    return PerfMonitor.setEnabled(!enabled);
  },
};
