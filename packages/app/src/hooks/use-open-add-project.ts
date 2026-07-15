import { useCallback } from "react";
import { useAddProjectFlowStore } from "@/stores/add-project-flow-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";

export function useOpenAddProject(): (preferredHostId?: string) => void {
  const openFlow = useAddProjectFlowStore((state) => state.open);
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);

  return useCallback(
    (preferredHostId?: string) => {
      openFlow(preferredHostId);
      setCommandCenterOpen(true);
    },
    [openFlow, setCommandCenterOpen],
  );
}
