/**
 * Whether the platform draws scrollers the legacy way, always shown, which takes
 * room from the content. The host sets `__gpuiScrollerLegacy` before the bundle
 * runs and reports a change with the `gpuiDesktop:scrollerStyle` device event.
 *
 * @format
 */

/** The width reserved for a legacy scroller, in points. */
export const LEGACY_SCROLLER_WIDTH = 12;

let legacy: boolean =
  (globalThis as { __gpuiScrollerLegacy?: boolean }).__gpuiScrollerLegacy ===
  true;
const listeners = new Set<() => void>();
let installed = false;

function install(): void {
  if (installed) {
    return;
  }
  installed = true;
  // Resolved lazily: the desktop entry loads this module while `react-native`
  // is still initializing, and the package's exports are not populated yet.
  const { DeviceEventEmitter } = require('react-native');
  DeviceEventEmitter.addListener(
    'gpuiDesktop:scrollerStyle',
    (event: { legacy?: boolean } | boolean) => {
      const next = typeof event === 'boolean' ? event : event?.legacy === true;
      if (next === legacy) {
        return;
      }
      legacy = next;
      listeners.forEach(listener => listener());
    },
  );
}

export function isLegacyScroller(): boolean {
  return legacy;
}

export function subscribeScrollerStyle(listener: () => void): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
