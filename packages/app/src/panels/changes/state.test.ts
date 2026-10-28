import { describe, expect, it } from "vitest";
import { changesStateSchema, defaultChangesState } from "./state";

describe("Changes pane state", () => {
  it("drops preferences formerly persisted per pane without resetting local document state", () => {
    expect(
      changesStateSchema.parse({
        ...defaultChangesState,
        mode: "base",
        baseRef: "origin/main",
        layout: "split",
        wrapLines: true,
        hideWhitespace: true,
      }),
    ).toEqual(defaultChangesState);
  });

  it("preserves plugin diff sessions through pane validation and tree updates", () => {
    const persisted = {
      ...defaultChangesState,
      treeVisible: true,
      collapsedFilePaths: ["src/a.ts"],
      pluginDiffPanels: {
        "editor/diff": { sessionId: "terminal-1", files: ["src/a.ts"] },
        "other/diff": { sessionId: "terminal-2" },
      },
    };
    const parsed = changesStateSchema.parse(persisted);
    expect(parsed).toEqual(persisted);
    expect(changesStateSchema.parse({ ...parsed, treeWidth: 350 }).pluginDiffPanels).toEqual(
      persisted.pluginDiffPanels,
    );
  });
});
