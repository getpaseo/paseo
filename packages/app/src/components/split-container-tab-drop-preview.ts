import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export interface TabDropPreview {
  paneId: string;
  insertionIndex: number;
  indicatorIndex: number;
}

interface ComputeTabDropPreviewInput {
  orientation?: "horizontal" | "vertical";
  activePaneId: string;
  activeTabId: string;
  overPaneId: string;
  overTabId: string;
  targetTabs: WorkspaceTabDescriptor[];
  activeRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  overRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export function computeTabDropPreview(input: ComputeTabDropPreviewInput): TabDropPreview | null {
  const targetIndex = input.targetTabs.findIndex((tab) => tab.tabId === input.overTabId);
  const orientation = input.orientation ?? "horizontal";
  const overSize = orientation === "vertical" ? input.overRect.height : input.overRect.width;
  if (targetIndex < 0 || overSize <= 0) {
    return null;
  }

  const activeCenter =
    orientation === "vertical"
      ? input.activeRect.top + input.activeRect.height / 2
      : input.activeRect.left + input.activeRect.width / 2;
  const overCenter =
    orientation === "vertical"
      ? input.overRect.top + input.overRect.height / 2
      : input.overRect.left + input.overRect.width / 2;
  const insertAfterTarget = activeCenter >= overCenter;

  const indicatorIndex = targetIndex + (insertAfterTarget ? 1 : 0);
  let insertionIndex = indicatorIndex;
  if (input.activePaneId === input.overPaneId) {
    const sourceIndex = input.targetTabs.findIndex((tab) => tab.tabId === input.activeTabId);
    if (sourceIndex < 0) {
      return null;
    }
    if (sourceIndex < insertionIndex) {
      insertionIndex -= 1;
    }
    insertionIndex = Math.max(0, Math.min(input.targetTabs.length - 1, insertionIndex));
  }

  return {
    paneId: input.overPaneId,
    insertionIndex,
    indicatorIndex,
  };
}
