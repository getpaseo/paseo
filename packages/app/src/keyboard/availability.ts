import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";

interface KeyboardShortcutEnvironment {
  isNative: boolean;
  isCompact: boolean;
}

export function keyboardShortcutsAvailable({
  isNative: native,
  isCompact,
}: KeyboardShortcutEnvironment): boolean {
  return !native && !isCompact;
}

export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  return keyboardShortcutsAvailable({ isNative, isCompact });
}

/**
 * Whether the runtime has a key event source at all, which is a wider question
 * than whether to render ⌘ badges. Native keeps its badges hidden — a phone
 * without a keyboard attached would be advertising shortcuts nobody can press —
 * while still routing the key commands iOS delivers.
 */
export function keyboardShortcutRoutingAvailable(env: KeyboardShortcutEnvironment): boolean {
  return env.isNative || keyboardShortcutsAvailable(env);
}
