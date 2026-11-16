import { hasFinePointer } from "@/hooks/pointer-capabilities";

/**
 * Whether this device takes touch sizes on a wide layout. The desktop app asks what the primary
 * pointer is rather than whether a touch screen exists: most Windows laptops with a touch screen
 * are driven by a trackpad, and Chromium reports a fine primary pointer for them. A tablet with
 * no mouse or trackpad attached reports a coarse one and stays touch-sized.
 */
export function deviceUsesTouchSizing(): boolean {
  return !hasFinePointer();
}
