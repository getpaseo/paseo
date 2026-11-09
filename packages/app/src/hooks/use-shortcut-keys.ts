import { usesDesktopBindings } from "@/keyboard";
import { useMemo } from "react";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";

/** `null` action ids are accepted so callers can keep the hook unconditional. */
export function useShortcutKeys(actionId: string | null): ShortcutKey[][] | null {
  const { overrides } = useKeyboardShortcutOverrides();
  const isMac = getShortcutOs() === "mac";

  return useMemo(() => {
    if (actionId === null) return null;
    return resolveShortcutKeysForAction(actionId, overrides, {
      isMac,
      usesDesktopBindings,
    });
  }, [actionId, overrides, isMac]);
}
