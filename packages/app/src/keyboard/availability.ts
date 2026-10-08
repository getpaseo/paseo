import { useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron, isNative } from "@/constants/platform";
import { desktopKeyboardAvailable } from "@/constants/input-behavior";

interface KeyboardShortcutEnvironment {
  isNative: boolean;
  isCompact: boolean;
  isElectron?: boolean;
}

export function keyboardShortcutsAvailable({
  isNative: native,
  isCompact,
  isElectron = false,
}: KeyboardShortcutEnvironment): boolean {
  return desktopKeyboardAvailable({ isNative: native, isCompact, isElectron });
}

export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  return keyboardShortcutsAvailable({ isNative, isCompact, isElectron: getIsElectron() });
}
