import { usePanelStore, type MobilePanelSelection } from "@/stores/panel-store";

/** Observe panel commands, including layout commands published before subscription. */
export function subscribeMobilePanelSelection(
  onSelection: (selection: MobilePanelSelection) => void,
) {
  const unsubscribe = usePanelStore.subscribe((state, previousState) => {
    if (state.mobilePanel !== previousState.mobilePanel) {
      onSelection(state.mobilePanel);
    }
  });
  onSelection(usePanelStore.getState().mobilePanel);
  return unsubscribe;
}
