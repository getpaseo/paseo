import { hasTouchScreen } from "@/hooks/pointer-capabilities";

/**
 * Whether this device takes touch sizes on a wide layout. Native and browsers ask whether a touch
 * screen exists at all, so an iPad keeps touch sizes with a trackpad attached.
 */
export function deviceUsesTouchSizing(): boolean {
  return hasTouchScreen();
}
