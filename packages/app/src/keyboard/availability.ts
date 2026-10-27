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

/**
 * The bindings the shortcut dispatcher listens for. Native has no dispatcher. Compact web
 * keeps only the bindings marked `compact`; everything else about shortcuts, hints and
 * help included, follows `keyboardShortcutsAvailable`.
 */
export function dispatchableShortcutBindings<Binding extends { compact?: true }>(
  bindings: readonly Binding[],
  { isNative: native, isCompact }: KeyboardShortcutEnvironment,
): readonly Binding[] {
  if (native) {
    return [];
  }
  if (isCompact) {
    return bindings.filter((binding) => binding.compact === true);
  }
  return bindings;
}

export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  return keyboardShortcutsAvailable({ isNative, isCompact });
}
