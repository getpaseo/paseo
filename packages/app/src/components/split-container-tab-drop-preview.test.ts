import { describe, expect, it } from "vitest";
import { computeTabDropPreview } from "@/components/split-container-tab-drop-preview";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

function tab(tabId: string): WorkspaceTabDescriptor {
  return {
    key: tabId,
    tabId,
    kind: "draft",
    target: {
      kind: "draft",
      draftId: tabId,
    },
  };
}

describe("computeTabDropPreview", () => {
  const targetTabs = [tab("a"), tab("b"), tab("c"), tab("d")];

  it("returns a before-target insertion index for cross-pane drops on the left half", () => {
    expect(
      computeTabDropPreview({
        activePaneId: "source",
        activeTabId: "x",
        overPaneId: "target",
        overTabId: "c",
        targetTabs,
        axis: "horizontal",
        activeRect: { left: 180, top: 0, width: 40, height: 28 },
        overRect: { left: 200, top: 0, width: 100, height: 28 },
      }),
    ).toEqual({
      paneId: "target",
      insertionIndex: 2,
      indicatorIndex: 2,
    });
  });

  it("returns an after-target insertion index for cross-pane drops on the right half", () => {
    expect(
      computeTabDropPreview({
        activePaneId: "source",
        activeTabId: "x",
        overPaneId: "target",
        overTabId: "c",
        targetTabs,
        axis: "horizontal",
        activeRect: { left: 280, top: 0, width: 40, height: 28 },
        overRect: { left: 200, top: 0, width: 100, height: 28 },
      }),
    ).toEqual({
      paneId: "target",
      insertionIndex: 3,
      indicatorIndex: 3,
    });
  });

  it("adjusts same-pane drops so insertion indexes match arrayMove semantics", () => {
    expect(
      computeTabDropPreview({
        activePaneId: "pane",
        activeTabId: "b",
        overPaneId: "pane",
        overTabId: "d",
        targetTabs,
        axis: "horizontal",
        activeRect: { left: 460, top: 0, width: 40, height: 28 },
        overRect: { left: 400, top: 0, width: 100, height: 28 },
      }),
    ).toEqual({
      paneId: "pane",
      insertionIndex: 3,
      indicatorIndex: 4,
    });
  });

  it("inserts above a column tab while the dragged tab is over its upper half", () => {
    expect(
      computeTabDropPreview({
        activePaneId: "source",
        activeTabId: "x",
        overPaneId: "target",
        overTabId: "c",
        targetTabs,
        axis: "vertical",
        // Far to the right of the target, where a row would read it as an after-target drop.
        activeRect: { left: 400, top: 56, width: 200, height: 28 },
        overRect: { left: 0, top: 64, width: 200, height: 28 },
      }),
    ).toEqual({
      paneId: "target",
      insertionIndex: 2,
      indicatorIndex: 2,
    });
  });

  it("inserts below a column tab once the dragged tab passes its midpoint", () => {
    expect(
      computeTabDropPreview({
        activePaneId: "source",
        activeTabId: "x",
        overPaneId: "target",
        overTabId: "c",
        targetTabs,
        axis: "vertical",
        activeRect: { left: 0, top: 70, width: 200, height: 28 },
        overRect: { left: 0, top: 64, width: 200, height: 28 },
      }),
    ).toEqual({
      paneId: "target",
      insertionIndex: 3,
      indicatorIndex: 3,
    });
  });
});
