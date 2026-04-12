import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

export function useShowShortcutBadges(): boolean {
  return useKeyboardShortcutsStore((state) => state.showShortcutBadges);
}
