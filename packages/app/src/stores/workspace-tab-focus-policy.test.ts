import { describe, expect, it } from "vitest";
import {
  resolveTabDepartureSuccessor,
  syncPaneTabFocusHistory,
} from "./workspace-tab-focus-policy";

describe("workspace tab departure focus policy", () => {
  it("relocate prefers most recently focused remaining tab over parent and neighbor", () => {
    const successor = resolveTabDepartureSuccessor("relocate", {
      pane: { id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" },
      departingTabId: "file",
      openTabIds: new Set(["a", "b", "file"]),
      parentTabIdByTabId: { file: "b" },
      paneFocusHistory: { main: ["file", "a", "b"] },
    });

    expect(successor).toBe("a");
  });

  it("relocate falls back to same-pane parent when focus history has no remaining tab", () => {
    const successor = resolveTabDepartureSuccessor("relocate", {
      pane: { id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" },
      departingTabId: "file",
      openTabIds: new Set(["a", "b", "file"]),
      parentTabIdByTabId: { file: "a" },
    });

    expect(successor).toBe("a");
  });

  it("relocate ignores a parent tab in another pane and falls back to source-pane neighbor", () => {
    const successor = resolveTabDepartureSuccessor("relocate", {
      pane: { id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" },
      departingTabId: "file",
      openTabIds: new Set(["other-pane-parent", "a", "b", "file"]),
      parentTabIdByTabId: { file: "other-pane-parent" },
    });

    expect(successor).toBe("b");
  });

  it("close prefers open parent tab anywhere, then right neighbor, then left neighbor", () => {
    expect(
      resolveTabDepartureSuccessor("close", {
        pane: { id: "main", tabIds: ["a", "file", "b"], focusedTabId: "file" },
        departingTabId: "file",
        openTabIds: new Set(["other-parent", "a", "file", "b"]),
        parentTabIdByTabId: { file: "other-parent" },
        paneFocusHistory: { main: ["file", "a", "b"] },
      }),
    ).toBe("other-parent");

    expect(
      resolveTabDepartureSuccessor("close", {
        pane: { id: "main", tabIds: ["a", "file", "b"], focusedTabId: "file" },
        departingTabId: "file",
        openTabIds: new Set(["a", "file", "b"]),
        paneFocusHistory: { main: ["file", "a", "b"] },
      }),
    ).toBe("b");

    expect(
      resolveTabDepartureSuccessor("close", {
        pane: { id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" },
        departingTabId: "file",
        openTabIds: new Set(["a", "b", "file"]),
        paneFocusHistory: { main: ["file", "a", "b"] },
      }),
    ).toBe("b");
  });

  it("returns null when the departing tab is not focused", () => {
    expect(
      resolveTabDepartureSuccessor("relocate", {
        pane: { id: "main", tabIds: ["a", "b", "file"], focusedTabId: "a" },
        departingTabId: "file",
        openTabIds: new Set(["a", "b", "file"]),
      }),
    ).toBeNull();
  });

  it("syncPaneTabFocusHistory seeds from prior focused tab, renames tabs, prunes closed tabs, and preserves identity when unchanged", () => {
    const initial = syncPaneTabFocusHistory({
      previousHistory: undefined,
      previousPanes: [{ id: "main", tabIds: ["a", "b", "file"], focusedTabId: "a" }],
      nextPanes: [{ id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" }],
    });
    expect(initial).toEqual({ main: ["file", "a"] });

    const unchanged = syncPaneTabFocusHistory({
      previousHistory: initial,
      previousPanes: [{ id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" }],
      nextPanes: [{ id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" }],
    });
    expect(unchanged).toBe(initial);

    const renamed = syncPaneTabFocusHistory({
      previousHistory: initial,
      previousPanes: [{ id: "main", tabIds: ["a", "b", "file"], focusedTabId: "file" }],
      nextPanes: [{ id: "main", tabIds: ["agent-a", "b", "file"], focusedTabId: "file" }],
      renamedTab: { from: "a", to: "agent-a" },
    });
    expect(renamed).toEqual({ main: ["file", "agent-a"] });

    const pruned = syncPaneTabFocusHistory({
      previousHistory: renamed,
      previousPanes: [{ id: "main", tabIds: ["agent-a", "b", "file"], focusedTabId: "file" }],
      nextPanes: [
        { id: "main", tabIds: ["agent-a", "b"], focusedTabId: "agent-a" },
        { id: "split", tabIds: ["file"], focusedTabId: "file" },
      ],
    });
    expect(pruned).toEqual({ main: ["agent-a"], split: ["file"] });
  });
});
