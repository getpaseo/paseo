import { isWeb } from "@/constants/platform";

/**
 * The DOM node behind a react-native ref, or null when there is none.
 *
 * react-native-web hands back the host element itself, so a `View` ref doubles as the
 * find surface's root; native refs are never DOM nodes, which is why this is checked
 * rather than cast.
 */
export function domElementOf(instance: unknown): HTMLElement | null {
  if (!isWeb) {
    return null;
  }
  return instance instanceof HTMLElement ? instance : null;
}
