import { describe, expect, it } from "vitest";
import { resolveSplitContainerRoot } from "@/components/split-container-focus";
import type { SplitNode } from "@/stores/workspace-layout-store";

const pane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null },
});
const root: SplitNode = {
  kind: "group",
  group: {
    id: "root",
    direction: "horizontal",
    children: [pane("left"), pane("right")],
    sizes: [0.5, 0.5],
  },
};

describe("split focus root", () => {
  it("renders only the valid focused pane in focus mode", () => {
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "right", focusModeEnabled: true }),
    ).toEqual({ root: pane("right"), usesFallbackStrip: false });
  });

  it("keeps the full tree and reserves the boundary strip when focus is missing", () => {
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "missing", focusModeEnabled: true }),
    ).toEqual({ root, usesFallbackStrip: true });
  });

  it("keeps normal splits unclaimed", () => {
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "right", focusModeEnabled: false }),
    ).toEqual({ root, usesFallbackStrip: false });
  });
});
