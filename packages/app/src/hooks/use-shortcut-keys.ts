import { useMemo } from "react";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { getIsElectronRuntime } from "@/constants/layout";

export function useShortcutKeys(actionId: string): ShortcutKey[][] | null {
  const { overrides } = useKeyboardShortcutOverrides();
  const isMac = getShortcutOs() === "mac";
  const isDesktopApp = getIsElectronRuntime();

  return useMemo(() => {
    return resolveShortcutKeysForAction(actionId, overrides, {
      isMac,
      isDesktop: isDesktopApp,
    });
  }, [actionId, overrides, isMac, isDesktopApp]);
}
