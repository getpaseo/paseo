import { useCallback } from "react";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

export function useOpenProjectPicker(_serverId: string | null): () => Promise<void> {
  const setAddProjectModalOpen = useKeyboardShortcutsStore((state) => state.setAddProjectModalOpen);

  return useCallback(async () => {
    setAddProjectModalOpen(true);
  }, [setAddProjectModalOpen]);
}
