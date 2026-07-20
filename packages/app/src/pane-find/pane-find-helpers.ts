import type { PaneFindController } from "./pane-find-controller";
import type { PaneFindAdapter } from "./pane-find-types";

export function normalizePaneFindQuery(query: string): string {
  return query.trim();
}

export function handlePaneFindInputKey(input: {
  key: string;
  shiftKey?: boolean;
  onClose: () => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
}): void {
  if (input.key === "Escape") {
    input.onClose();
    return;
  }
  if (input.key !== "Enter") return;
  if (input.shiftKey) {
    input.onSelectPrev();
    return;
  }
  input.onSelectNext();
}

export function toggleActivePaneFind(
  controller: Pick<PaneFindController, "getActiveState" | "closeActive" | "openActive">,
): boolean {
  const state = controller.getActiveState();
  if (!state) return false;
  if (state.isOpen) {
    controller.closeActive();
    return true;
  }
  return controller.openActive();
}

export function registerPaneFindAdapter(input: {
  controller: Pick<PaneFindController, "register">;
  paneKey: string | null;
  adapter: PaneFindAdapter;
}): (() => void) | undefined {
  if (!input.paneKey) return undefined;
  return input.controller.register(input.paneKey, input.adapter);
}
