import { describe, expect, it } from "vitest";
import type { SplitNode } from "@/stores/workspace-layout-store";
import { findMainPane } from "@/stores/workspace-layout-store";

function createPane(input: { id: string; createdAt: number; tabIds?: string[] }): SplitNode {
  const tabIds = input.tabIds ?? [];
  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabIds,
      focusedTabId: tabIds[0] ?? null,
      createdAt: input.createdAt,
    },
  };
}

describe("findMainPane", () => {
  it("returns the earliest-created pane across nested groups", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          createPane({ id: "secondary", createdAt: 20 }),
          {
            kind: "group",
            group: {
              id: "nested",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "main", createdAt: 0 }),
                createPane({ id: "tertiary", createdAt: 30 }),
              ],
            },
          },
        ],
      },
    };

    expect(findMainPane(root)?.id).toBe("main");
  });
});
