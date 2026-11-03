import { describe, expect, it } from "vitest";
import {
  DEFAULT_TREE_RAIL_WIDTH,
  migratePanelState,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
  setMobilePanelTarget,
  type PanelCoreState,
} from "./state";

function makePanelState(overrides: Partial<PanelCoreState> = {}): PanelCoreState {
  return {
    mobilePanel: { target: "agent", revision: 0 },
    desktop: {
      agentListOpen: false,
      focusModeEnabled: false,
    },
    ...overrides,
  };
}

describe("panel-store migration", () => {
  it("defaults hidden-file visibility to showing hidden files", () => {
    const state = migratePanelState({}, 10);

    expect(state.explorerShowHiddenFiles).toBe(true);
  });

  it("initializes diffCollapsedFoldersByWorkspace for pre-v12 state", () => {
    const state = migratePanelState({}, 11);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({});
  });

  it("preserves an existing diffCollapsedFoldersByWorkspace map", () => {
    const state = migratePanelState({ diffCollapsedFoldersByWorkspace: { ws: ["src/app"] } }, 12);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({ ws: ["src/app"] });
  });

  it("initializes and preserves collapsed diff file paths by workspace", () => {
    expect(migratePanelState({}, 14).collapsedFilePathsByWorkspace).toEqual({});
    expect(
      migratePanelState({ collapsedFilePathsByWorkspace: { ws: ["src/app.ts"] } }, 14)
        .collapsedFilePathsByWorkspace,
    ).toEqual({ ws: ["src/app.ts"] });
  });

  it("drops the retired per-file diff expansion state", () => {
    const state = migratePanelState({ diffExpandedPathsByWorkspace: { ws: ["src/app.ts"] } }, 13);

    expect(state.diffExpandedPathsByWorkspace).toBeUndefined();
  });

  it("replaces the dead explorer split ratio with the shared tree rail width", () => {
    const state = migratePanelState({ explorerFilesSplitRatio: 0.5 }, 12);

    expect(state.explorerFilesSplitRatio).toBeUndefined();
    expect(state.treeRailWidth).toBe(DEFAULT_TREE_RAIL_WIDTH);
  });

  it("narrows an existing install's tree rail to the new default width", () => {
    expect(DEFAULT_TREE_RAIL_WIDTH).toBeLessThan(320);
    expect(migratePanelState({ treeRailWidth: 320 }, 15).treeRailWidth).toBe(
      DEFAULT_TREE_RAIL_WIDTH,
    );
  });

  it("defaults the file panel tree to open and keeps it closed once closed", () => {
    expect(migratePanelState({}, 15).fileTreeVisible).toBe(true);
    expect(migratePanelState({ fileTreeVisible: false }, 16).fileTreeVisible).toBe(false);
  });

  it("drops persisted compact panel state so cold starts return to content", () => {
    const state = migratePanelState(
      { mobileView: "agent-list", mobilePanel: { target: "file-explorer", revision: 42 } },
      11,
    );

    expect(state.mobileView).toBeUndefined();
    expect(state.mobilePanel).toBeUndefined();
  });
});

describe("panel-store visibility selectors", () => {
  it("increments the mobile panel revision only when the target changes", () => {
    const initial = { target: "agent" as const, revision: 4 };

    expect(setMobilePanelTarget(initial, "agent")).toBe(initial);
    expect(setMobilePanelTarget(initial, "agent-list")).toEqual({
      target: "agent-list",
      revision: 5,
    });
  });

  it("uses the mobile panel target for compact layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, focusModeEnabled: false },
    });

    expect(selectIsAgentListOpen(state, { isCompact: true })).toBe(false);
    expect(selectIsCompactFileExplorerOpen(state)).toBe(true);
  });

  it("uses the desktop flag for the expanded agent list", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true, focusModeEnabled: false },
    });

    expect(selectIsAgentListOpen(state, { isCompact: false })).toBe(true);
  });
});

it("discards obsolete checkout selection while preserving other panel preferences", () => {
  const state = migratePanelState(
    { explorerTab: "files", explorerTabByCheckout: { checkout: "changes" }, sidebarWidth: 400 },
    16,
  );
  expect(state).not.toHaveProperty("explorerTab");
  expect(state).not.toHaveProperty("explorerTabByCheckout");
  expect(state.sidebarWidth).toBe(400);
});
