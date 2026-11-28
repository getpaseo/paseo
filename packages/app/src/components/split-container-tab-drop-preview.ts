import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export interface TabDropPreview {
  paneId: string;
  insertionIndex: number;
  indicatorIndex: number;
}

/** The direction a pane's tab rail runs: across the top, or down the left side. */
export type TabRailAxis = "horizontal" | "vertical";

interface TabDropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ComputeTabDropPreviewInput {
  activePaneId: string;
  activeTabId: string;
  overPaneId: string;
  overTabId: string;
  targetTabs: WorkspaceTabDescriptor[];
  /** The axis of the rail being dropped into, which decides the half that means "after". */
  axis: TabRailAxis;
  activeRect: TabDropRect;
  overRect: TabDropRect;
}

function centerAlongAxis(rect: TabDropRect, axis: TabRailAxis): number {
  return axis === "vertical" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
}

export function computeTabDropPreview(input: ComputeTabDropPreviewInput): TabDropPreview | null {
  const targetIndex = input.targetTabs.findIndex((tab) => tab.tabId === input.overTabId);
  if (targetIndex < 0 || input.overRect.width <= 0 || input.overRect.height <= 0) {
    return null;
  }

  const insertAfterTarget =
    centerAlongAxis(input.activeRect, input.axis) >= centerAlongAxis(input.overRect, input.axis);

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
