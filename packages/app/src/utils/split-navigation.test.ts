import { describe, expect, it } from "vitest";
import type { SplitNode } from "@/stores/workspace-layout-store";
import { findAdjacentPane } from "./split-navigation";

function createPaneNode(id: string): SplitNode {
  return {
    kind: "pane",
    pane: {
      id,
      tabIds: [],
      focusedTabId: null,
      tabBarOrientation: "horizontal",
    },
  };
}

function createGroupNode(input: {
  direction: "horizontal" | "vertical";
  sizes: number[];
  children: SplitNode[];
}): SplitNode {
  return {
    kind: "group",
    group: {
      id: `${input.direction}-group`,
      direction: input.direction,
      sizes: input.sizes,
      children: input.children,
    },
  };
}

describe("findAdjacentPane", () => {
  it("finds direct horizontal and vertical neighbors in nested layouts", () => {
    const root = createGroupNode({
      direction: "horizontal",
      sizes: [0.25, 0.5, 0.25],
      children: [
        createPaneNode("left"),
        createGroupNode({
          direction: "vertical",
          sizes: [0.5, 0.5],
          children: [createPaneNode("top-middle"), createPaneNode("bottom-middle")],
        }),
        createPaneNode("right"),
      ],
    });

    expect(findAdjacentPane(root, "top-middle", "left")).toBe("left");
    expect(findAdjacentPane(root, "top-middle", "right")).toBe("right");
    expect(findAdjacentPane(root, "top-middle", "down")).toBe("bottom-middle");
    expect(findAdjacentPane(root, "bottom-middle", "up")).toBe("top-middle");
  });

  it("returns null when there is no pane in the requested direction", () => {
    const root = createGroupNode({
      direction: "horizontal",
      sizes: [0.5, 0.5],
      children: [createPaneNode("left"), createPaneNode("right")],
    });

    expect(findAdjacentPane(root, "left", "left")).toBeNull();
    expect(findAdjacentPane(root, "right", "right")).toBeNull();
    expect(findAdjacentPane(root, "left", "up")).toBeNull();
  });

  it("prefers the closest overlapping pane when multiple candidates exist", () => {
    const root = createGroupNode({
      direction: "vertical",
      sizes: [0.5, 0.5],
      children: [
        createPaneNode("top"),
        createGroupNode({
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [createPaneNode("bottom-left"), createPaneNode("bottom-right")],
        }),
      ],
    });

    expect(findAdjacentPane(root, "top", "down")).toBe("bottom-left");
    expect(findAdjacentPane(root, "bottom-right", "up")).toBe("top");
  });
});
