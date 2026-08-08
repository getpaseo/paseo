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
