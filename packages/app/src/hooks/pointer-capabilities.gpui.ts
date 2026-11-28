import type { PointerCapabilities, PointerCapabilitiesSource } from "./pointer-capabilities";

export type { PointerCapabilities, PointerCapabilitiesSource };

// The GPUI desktop client runs in a macOS, Linux, or Windows window. The runtime reports
// every pointer as a mouse, so a fine pointer drives the UI and the answer never changes.
const GPUI_POINTER_CAPABILITIES: PointerCapabilities = { finePointer: true, touchScreen: false };

export function usePointerCapabilities(): PointerCapabilities {
  return GPUI_POINTER_CAPABILITIES;
}

/** True when a mouse-like pointer drives the UI, read at call time. */
export function hasFinePointer(): boolean {
  return true;
}

/** True when touch is the primary input, read at call time. */
export function hasTouchPrimaryPointer(): boolean {
  return false;
}
