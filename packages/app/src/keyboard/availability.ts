import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHardwareKeyboardStore } from "@/stores/hardware-keyboard-store";

interface KeyboardShortcutEnvironment {
  isNative: boolean;
  isCompact: boolean;
}

/**
 * Whether the DOM keyboard-shortcut pipeline runs. Native delivers shortcuts
 * through the hardware-keyboard module instead — use
 * useKeyboardShortcutsAvailable for "should shortcut UI be shown".
 */
export function keyboardShortcutsAvailable({
  isNative: native,
  isCompact,
}: KeyboardShortcutEnvironment): boolean {
  return !native && !isCompact;
}

/**
 * Whether shortcut affordances (hint chips, badges, settings list) should be
 * shown. On native that means a hardware keyboard is connected; on web it
 * means a non-compact layout.
 */
export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  const hardwareKeyboardConnected = useHardwareKeyboardStore((s) => s.connected);
  if (isNative) return hardwareKeyboardConnected;
  return !isCompact;
}
