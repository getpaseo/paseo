import { describe, expect, it } from "vitest";
import {
  hasMultipleVisiblePanes,
  removePaneFromSplitTree,
  resolveSplitContainerRoot,
  splitNodeContainsPane,
} from "@/components/split-container-focus";
import type { SplitNode } from "@/stores/workspace-layout-store";

const pane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null },
});
const hiddenPane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null, hidden: true },
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

  it("finds the maximized pane without replacing the rendered split tree", () => {
    expect(splitNodeContainsPane(root, "right")).toBe(true);
    expect(splitNodeContainsPane(root, "missing")).toBe(false);
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "left", focusModeEnabled: false }),
    ).toEqual({ root, usesFallbackStrip: false });
  });

  it("offers pane maximize only when another pane is visible", () => {
    expect(hasMultipleVisiblePanes(root)).toBe(true);
    expect(hasMultipleVisiblePanes(pane("left"))).toBe(false);
    expect(
      hasMultipleVisiblePanes({
        ...root,
        group: { ...root.group, children: [pane("left"), hiddenPane("right")] },
      }),
    ).toBe(false);
  });
});

it("keeps browser and conversation proportions when docking Explorer outside the canvas", () => {
  const content: SplitNode = {
    kind: "group",
    group: {
      id: "conversations",
      direction: "horizontal",
      children: [pane("left"), pane("middle"), pane("explorer")],
      sizes: [0.2, 0.6, 0.2],
    },
  };
  const layout: SplitNode = {
    kind: "group",
    group: {
      id: "browser",
      direction: "horizontal",
      children: [content, pane("browser")],
      sizes: [0.35, 0.65],
    },
  };
  const visible = removePaneFromSplitTree(layout, "explorer");
  expect(visible?.kind === "group" && visible.group.sizes).toEqual([0.35, 0.65]);
  const remaining = visible?.kind === "group" && visible.group.children[0];
  if (!remaining || remaining.kind !== "group") throw new Error("Expected conversation split");
  expect(remaining.group.sizes[0]).toBeCloseTo(0.25);
  expect(remaining.group.sizes[1]).toBeCloseTo(0.75);
});
