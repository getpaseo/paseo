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
        activeRect: { left: 180, top: 0, width: 40, height: 30 },
        overRect: { left: 200, top: 0, width: 100, height: 30 },
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
        activeRect: { left: 280, top: 0, width: 40, height: 30 },
        overRect: { left: 200, top: 0, width: 100, height: 30 },
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
        activeRect: { left: 460, top: 0, width: 40, height: 30 },
        overRect: { left: 400, top: 0, width: 100, height: 30 },
      }),
    ).toEqual({
      paneId: "pane",
      insertionIndex: 3,
      indicatorIndex: 4,
    });
  });

  it("returns a before-target insertion index for vertical drops on the top half", () => {
    expect(
      computeTabDropPreview({
        orientation: "vertical",
        activePaneId: "source",
        activeTabId: "x",
        overPaneId: "target",
        overTabId: "c",
        targetTabs,
        activeRect: { left: 0, top: 180, width: 180, height: 40 },
        overRect: { left: 0, top: 200, width: 180, height: 100 },
      }),
    ).toEqual({
      paneId: "target",
      insertionIndex: 2,
      indicatorIndex: 2,
    });
  });

  it("returns an after-target insertion index for vertical drops on the bottom half", () => {
    expect(
      computeTabDropPreview({
        orientation: "vertical",
        activePaneId: "source",
        activeTabId: "x",
        overPaneId: "target",
        overTabId: "c",
        targetTabs,
        activeRect: { left: 0, top: 280, width: 180, height: 40 },
        overRect: { left: 0, top: 200, width: 180, height: 100 },
      }),
    ).toEqual({
      paneId: "target",
      insertionIndex: 3,
      indicatorIndex: 3,
    });
  });
});
