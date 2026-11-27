import { usePanelStore, type MobilePanelSelection } from "@/stores/panel-store";

/** Observe panel commands, including layout commands published before subscription. */
export function subscribeMobilePanelSelection(
  onSelection: (selection: MobilePanelSelection, immediate: boolean) => void,
) {
  const unsubscribe = usePanelStore.subscribe((state, previousState) => {
    if (state.mobilePanel !== previousState.mobilePanel) {
      onSelection(state.mobilePanel, state.layout.leftSidebar === "suspended");
    }
  });
  const state = usePanelStore.getState();
  onSelection(state.mobilePanel, state.layout.leftSidebar === "suspended");
  return unsubscribe;
}
