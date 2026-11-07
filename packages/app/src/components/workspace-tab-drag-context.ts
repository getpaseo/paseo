import { createContext, useContext } from "react";
import type { TabDropPreview } from "./split-container-tab-drop-preview";
import type { SplitDropZoneHover } from "./split-drop-zone";
export const WorkspaceTabDragContext = createContext<{
  activeDragTabId: string | null;
  dropPreview: SplitDropZoneHover | null;
  tabDropPreview: TabDropPreview | null;
  externalDndContext: boolean;
}>({ activeDragTabId: null, dropPreview: null, tabDropPreview: null, externalDndContext: false });
export function useWorkspaceTabDrag() {
  return useContext(WorkspaceTabDragContext);
}
