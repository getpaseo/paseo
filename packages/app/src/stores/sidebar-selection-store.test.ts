import { beforeEach, describe, expect, it } from "vitest";
import {
  computeRangeSelection,
  computeToggleSelection,
  useSidebarSelectionStore,
  WHOLE_ORDER_SEGMENT_ID,
  type SidebarSelectionTarget,
} from "@/stores/sidebar-selection-store";

function target(key: string, serverId = "s1"): SidebarSelectionTarget {
  return { serverId, workspaceId: `${serverId}-${key}`, workspaceKey: `${serverId}:${key}` };
}

const ORDER = [target("a"), target("b"), target("c"), target("d", "s2"), target("e")];

describe("computeRangeSelection", () => {
  it("slices inclusively between anchor and target regardless of direction", () => {
    expect(computeRangeSelection(ORDER, "s1:a", "s1:c").map((entry) => entry.workspaceKey)).toEqual(
      ["s1:a", "s1:b", "s1:c"],
    );
    expect(computeRangeSelection(ORDER, "s1:c", "s1:a").map((entry) => entry.workspaceKey)).toEqual(
      ["s1:a", "s1:b", "s1:c"],
    );
  });

  it("spans across section boundaries and hosts", () => {
    expect(computeRangeSelection(ORDER, "s1:b", "s1:e").map((entry) => entry.workspaceKey)).toEqual(
      ["s1:b", "s1:c", "s2:d", "s1:e"],
    );
  });

  it("selects only the target when the anchor is gone from the visible order", () => {
    expect(
      computeRangeSelection(ORDER, "s1:missing", "s1:c").map((entry) => entry.workspaceKey),
    ).toEqual(["s1:c"]);
  });

  it("selects nothing when the target is not in the visible order", () => {
    expect(computeRangeSelection(ORDER, "s1:a", "s1:missing")).toEqual([]);
  });
});

describe("computeToggleSelection", () => {
  it("adds an unselected row", () => {
    const result = computeToggleSelection([target("a")], target("c"));
    expect(result.removed).toBe(false);
    expect(result.selected.map((entry) => entry.workspaceKey)).toEqual(["s1:a", "s1:c"]);
  });

  it("removes a selected row", () => {
    const result = computeToggleSelection([target("a"), target("c")], target("a"));
    expect(result.removed).toBe(true);
    expect(result.selected.map((entry) => entry.workspaceKey)).toEqual(["s1:c"]);
  });
});

describe("useSidebarSelectionStore", () => {
  beforeEach(() => {
    const store = useSidebarSelectionStore.getState();
    store.clear();
    // clear() keeps the registered segments (production lists re-register on their own), so the
    // tests drop them explicitly to stay isolated from each other.
    for (const segment of store.segments) {
      if (segment.id !== WHOLE_ORDER_SEGMENT_ID) {
        store.removeSegment(segment.id);
      }
    }
    store.setOrder(ORDER);
  });

  it("segments compose the flat order in registration order and keep their slot on removal", () => {
    const store = useSidebarSelectionStore.getState();
    store.clear();
    store.removeSegment(WHOLE_ORDER_SEGMENT_ID);
    store.setSegment("a", 1, [target("a"), target("b")]);
    store.setSegment("b", 2, [target("c")]);
    const state = useSidebarSelectionStore.getState();
    expect(state.segments.map((segment) => segment.id)).toEqual(["a", "b"]);
    expect(state.order.map((entry) => entry.workspaceKey)).toEqual(["s1:a", "s1:b", "s1:c"]);

    store.handleSelectPress(target("a"), { range: false });
    store.handleSelectPress(target("c"), { range: true });
    expect(useSidebarSelectionStore.getState().selected.length).toBe(3);

    // Unmounting a section drops its rows from the order but leaves the selection alone —
    // batch actions re-check every row against live state before acting.
    store.removeSegment("a");
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:c",
    ]);
    expect(useSidebarSelectionStore.getState().selected.map((entry) => entry.workspaceKey)).toEqual(
      ["s1:a", "s1:b", "s1:c"],
    );
  });

  it("a row update updates the section in place: selections and slot positions survive", () => {
    const store = useSidebarSelectionStore.getState();
    store.clear();
    store.removeSegment(WHOLE_ORDER_SEGMENT_ID);
    // Three sections registered in visual order: a, b, c.
    store.setSegment("a", 1, [target("a")]);
    store.setSegment("b", 2, [target("b")]);
    store.setSegment("c", 3, [target("c")]);

    // The user selects across b's rows, then b renders MORE rows ("show more").
    store.handleSelectPress(target("b"), { range: false });
    store.handleSelectPress(target("a"), { range: false });
    store.setSegment("b", 2, [target("b"), target("b2")]);

    // The selection survives the row update — nothing was erased.
    expect(useSidebarSelectionStore.getState().selected.map((entry) => entry.workspaceKey)).toEqual(
      ["s1:b", "s1:a"],
    );

    // Collapsing b empties its slot without deleting it, so reopening puts it back in place.
    store.setSegment("b", 2, []);
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:a",
      "s1:c",
    ]);
    store.setSegment("b", 2, [target("b"), target("b2")]);
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:a",
      "s1:b",
      "s1:b2",
      "s1:c",
    ]);
  });

  it("segments sort by their explicit visual position, not registration order", () => {
    const store = useSidebarSelectionStore.getState();
    store.clear();
    store.removeSegment(WHOLE_ORDER_SEGMENT_ID);
    // A status group can appear after sections that visually sit behind it (a workspace failing
    // while only the done group rendered) — its position places it where the user sees it.
    store.setSegment("done", 3, [target("c")]);
    store.setSegment("running", 2, [target("b")]);
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:b",
      "s1:c",
    ]);
    store.setSegment("failed", 1, [target("a")]);
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:a",
      "s1:b",
      "s1:c",
    ]);

    // And a collapsed-then-reopened group returns to its own position, not the end.
    store.setSegment("running", 2, []);
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:a",
      "s1:c",
    ]);
    store.setSegment("running", 2, [target("b"), target("b2")]);
    expect(useSidebarSelectionStore.getState().order.map((entry) => entry.workspaceKey)).toEqual([
      "s1:a",
      "s1:b",
      "s1:b2",
      "s1:c",
    ]);
  });

  it("re-registering the same targets reference does not touch derived state", () => {
    const store = useSidebarSelectionStore.getState();
    store.clear();
    const targets = [target("a")];
    store.setSegment("a", 1, targets);
    store.handleSelectPress(target("a"), { range: false });
    const before = useSidebarSelectionStore.getState().selected;
    store.setSegment("a", 1, targets);
    expect(useSidebarSelectionStore.getState().selected).toBe(before);
  });

  it("re-registering the same targets reference does not touch derived state", () => {
    const store = useSidebarSelectionStore.getState();
    store.clear();
    const targets = [target("a")];
    store.setSegment("a", 1, targets);
    store.handleSelectPress(target("a"), { range: false });
    const before = useSidebarSelectionStore.getState().selected;
    store.setSegment("a", 1, targets);
    expect(useSidebarSelectionStore.getState().selected).toBe(before);
  });

  it("a plain press selects one row and moves the anchor", () => {
    useSidebarSelectionStore.getState().handleSelectPress(target("b"), { range: false });
    const state = useSidebarSelectionStore.getState();
    expect(state.selected.map((entry) => entry.workspaceKey)).toEqual(["s1:b"]);
    expect(state.anchorKey).toBe("s1:b");
  });

  it("pressing the only selected row deselects it and drops the anchor", () => {
    const store = useSidebarSelectionStore.getState();
    store.handleSelectPress(target("b"), { range: false });
    useSidebarSelectionStore.getState().handleSelectPress(target("b"), { range: false });
    const state = useSidebarSelectionStore.getState();
    expect(state.selected).toEqual([]);
    expect(state.selectedKeys.size).toBe(0);
    expect(state.anchorKey).toBeNull();
  });

  it("toggling one row among several keeps the rest", () => {
    const store = useSidebarSelectionStore.getState();
    store.handleSelectPress(target("a"), { range: false });
    store.handleSelectPress(target("c"), { range: false });
    useSidebarSelectionStore.getState().handleSelectPress(target("b"), { range: false });
    expect(useSidebarSelectionStore.getState().selected.map((entry) => entry.workspaceKey)).toEqual(
      ["s1:a", "s1:c", "s1:b"],
    );
    useSidebarSelectionStore.getState().handleSelectPress(target("a"), { range: false });
    expect(useSidebarSelectionStore.getState().selected.map((entry) => entry.workspaceKey)).toEqual(
      ["s1:c", "s1:b"],
    );
  });

  it("a range press extends from the anchor without moving it", () => {
    const store = useSidebarSelectionStore.getState();
    store.handleSelectPress(target("b"), { range: false });
    useSidebarSelectionStore.getState().handleSelectPress(target("d", "s2"), { range: true });
    const state = useSidebarSelectionStore.getState();
    expect(state.selected.map((entry) => entry.workspaceKey)).toEqual(["s1:b", "s1:c", "s2:d"]);
    expect(state.anchorKey).toBe("s1:b");
  });

  it("a whole-order update leaves the selection and anchor alone", () => {
    const store = useSidebarSelectionStore.getState();
    store.handleSelectPress(target("a"), { range: false });
    store.handleSelectPress(target("e"), { range: true });
    expect(useSidebarSelectionStore.getState().selected.length).toBe(5);

    // The renderer re-registers a smaller visible order (a filter, a collapse); what the user
    // selected stays selected, and batch actions re-check rows against live state themselves.
    useSidebarSelectionStore.getState().setOrder([target("b"), target("c"), target("e")]);
    const state = useSidebarSelectionStore.getState();
    expect(state.order.map((entry) => entry.workspaceKey)).toEqual(["s1:b", "s1:c", "s1:e"]);
    expect(state.selected.length).toBe(5);
    expect(state.anchorKey).toBe("s1:a");
  });

  it("a plain press selects just that row, so the next ctrl press adds on top of it", () => {
    const store = useSidebarSelectionStore.getState();
    store.handleSelectPress(target("a"), { range: false });
    store.handleSelectPress(target("c"), { range: true });
    expect(useSidebarSelectionStore.getState().selected.length).toBe(3);

    // The user plain-clicks row d — it navigates and the multi-selection resets to just d.
    useSidebarSelectionStore.getState().handleNavigatePress(target("d", "s2"));
    const state = useSidebarSelectionStore.getState();
    expect(state.selected.map((entry) => entry.workspaceKey)).toEqual(["s2:d"]);
    expect(state.anchorKey).toBe("s2:d");

    // A ctrl press then adds on top of the plain-clicked row.
    useSidebarSelectionStore.getState().handleSelectPress(target("b"), { range: false });
    expect(useSidebarSelectionStore.getState().selected.map((entry) => entry.workspaceKey)).toEqual(
      ["s2:d", "s1:b"],
    );

    // And a shift press extends from the last-pressed row (the ctrl press moved the anchor),
    // replacing the selection with the anchor..target slice.
    useSidebarSelectionStore.getState().handleSelectPress(target("e"), { range: true });
    expect(useSidebarSelectionStore.getState().selected.map((entry) => entry.workspaceKey)).toEqual(
      ["s1:b", "s1:c", "s2:d", "s1:e"],
    );
  });

  it("clear empties the selection and the anchor", () => {
    const store = useSidebarSelectionStore.getState();
    store.handleSelectPress(target("a"), { range: false });
    store.handleSelectPress(target("c"), { range: true });
    useSidebarSelectionStore.getState().clear();
    const state = useSidebarSelectionStore.getState();
    expect(state.selected).toEqual([]);
    expect(state.selectedKeys.size).toBe(0);
    expect(state.anchorKey).toBeNull();
  });
});
