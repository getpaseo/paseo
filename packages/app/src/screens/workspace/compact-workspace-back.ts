import type { BackPressSource } from "@/components/ui/isolated-bottom-sheet-modal/visibility-tracker";
import type { MobilePanelView } from "@/stores/panel-store";

/** The compact workspace's panels: the chat, the workspace list and the file explorer. */
export interface CompactWorkspacePanels {
  current(): MobilePanelView;
  show(panel: MobilePanelView): void;
}

/**
 * The panel Android Back shows in a compact workspace, given the one on screen, or null
 * to leave Back to the system. Back from a chat opens the workspace list, and Back from
 * the file explorer returns to the chat. From the workspace list, Back leaves the app,
 * as it does from the conversation list in other chat apps.
 */
export function resolveCompactWorkspaceBack(current: MobilePanelView): MobilePanelView | null {
  switch (current) {
    case "agent":
      return "agent-list";
    case "file-explorer":
      return "agent";
    case "agent-list":
      return null;
  }
}

/**
 * Handles Back for a focused compact workspace. Overlays that subscribe later, such as
 * bottom sheets and the fullscreen composer, are offered the press first and still close
 * before the workspace changes panels.
 */
export function subscribeCompactWorkspaceBack(
  backPress: BackPressSource,
  panels: CompactWorkspacePanels,
): () => void {
  return backPress.subscribe(() => {
    const next = resolveCompactWorkspaceBack(panels.current());
    if (!next) return false;
    panels.show(next);
    return true;
  });
}
