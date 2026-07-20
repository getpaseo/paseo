import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPaneFindController, type PaneFindController } from "./pane-find-controller";
import type { PaneFindAdapter, PaneFindState } from "./pane-find-types";

function makeAdapter(overrides: Partial<PaneFindState> = {}): PaneFindAdapter & {
  state: PaneFindState;
} {
  const state: PaneFindState = {
    isOpen: false,
    query: "",
    isPending: false,
    matchCount: 0,
    selectedIndex: -1,
    ...overrides,
  };
  return {
    hasCustomUI: false,
    state,
    getState: () => state,
    subscribe: () => () => {},
    open: vi.fn(() => {
      state.isOpen = true;
    }),
    close: vi.fn(() => {
      state.isOpen = false;
    }),
    setQuery: vi.fn((query: string) => {
      state.query = query;
    }),
    selectNext: vi.fn(),
    selectPrev: vi.fn(),
  };
}

describe("pane-find-controller", () => {
  let controller: PaneFindController;

  beforeEach(() => {
    controller = createPaneFindController();
  });

  it("has no focused pane and no active adapter before any registration", () => {
    expect(controller.getFocusedPane()).toBeNull();
    expect(controller.getActiveAdapter()).toBeNull();
    expect(controller.getActiveState()).toBeNull();
  });

  it("routes open/close/query/next/prev to the focused pane's adapter", () => {
    const adapter = makeAdapter();
    controller.register("pane-a", adapter);
    controller.setFocusedPane("pane-a");

    expect(controller.openActive()).toBe(true);
    expect(adapter.open).toHaveBeenCalledTimes(1);

    controller.setQueryActive("hello");
    expect(adapter.setQuery).toHaveBeenCalledWith("hello");

    controller.selectNextActive();
    controller.selectPrevActive();
    expect(adapter.selectNext).toHaveBeenCalledTimes(1);
    expect(adapter.selectPrev).toHaveBeenCalledTimes(1);

    controller.closeActive();
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it("does not route commands to a registered but unfocused pane", () => {
    const focused = makeAdapter();
    const other = makeAdapter();
    controller.register("focused-pane", focused);
    controller.register("other-pane", other);
    controller.setFocusedPane("focused-pane");

    controller.setQueryActive("only for focused");

    expect(focused.setQuery).toHaveBeenCalledWith("only for focused");
    expect(other.setQuery).not.toHaveBeenCalled();
  });

  it("openActive returns false and is a no-op when no pane is focused", () => {
    const adapter = makeAdapter();
    controller.register("pane-a", adapter);
    // Registered, but never focused.

    expect(controller.openActive()).toBe(false);
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("increments a subscribable focus request revision for every open request", () => {
    const adapter = makeAdapter();
    const listener = vi.fn();
    controller.register("pane-a", adapter);
    controller.setFocusedPane("pane-a");
    controller.subscribe(listener);

    expect(controller.getFocusRequestRevision()).toBe(0);

    controller.openActive();
    expect(controller.getFocusRequestRevision()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    controller.openActive();
    expect(controller.getFocusRequestRevision()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("switches focus between panes so routing follows the newly focused pane", () => {
    const paneA = makeAdapter();
    const paneB = makeAdapter();
    controller.register("pane-a", paneA);
    controller.register("pane-b", paneB);

    controller.setFocusedPane("pane-a");
    controller.openActive();
    expect(paneA.open).toHaveBeenCalledTimes(1);
    expect(paneB.open).not.toHaveBeenCalled();

    controller.setFocusedPane("pane-b");
    controller.openActive();
    expect(paneB.open).toHaveBeenCalledTimes(1);
    expect(paneA.open).toHaveBeenCalledTimes(1);
  });

  it("cleans up on unregister: the pane's adapter stops receiving commands", () => {
    const adapter = makeAdapter();
    const unregister = controller.register("pane-a", adapter);
    controller.setFocusedPane("pane-a");

    unregister();

    // Focus ownership is managed centrally (WorkspacePaneContent) and is NOT
    // cleared on unregister — but with no adapter registered the focused key
    // resolves to nothing, so commands no-op.
    expect(controller.getActiveAdapter()).toBeNull();
    expect(controller.openActive()).toBe(false);
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("unregister is a no-op when a newer adapter has since replaced it under the same key", () => {
    const first = makeAdapter();
    const second = makeAdapter();
    const unregisterFirst = controller.register("pane-a", first);
    controller.register("pane-a", second);
    controller.setFocusedPane("pane-a");

    unregisterFirst();

    expect(controller.getActiveAdapter()).toBe(second);
  });

  it("clearFocusedPaneIfCurrent only clears when the key still matches the focused pane", () => {
    const adapter = makeAdapter();
    controller.register("pane-a", adapter);
    controller.setFocusedPane("pane-a");

    controller.clearFocusedPaneIfCurrent("pane-b");
    expect(controller.getFocusedPane()).toBe("pane-a");

    controller.clearFocusedPaneIfCurrent("pane-a");
    expect(controller.getFocusedPane()).toBeNull();
  });

  it("exposes the focused adapter's pending/no-match/count state", () => {
    const adapter = makeAdapter({ query: "abc", matchCount: 0, isPending: true });
    controller.register("pane-a", adapter);
    controller.setFocusedPane("pane-a");

    expect(controller.getActiveState()).toEqual({
      isOpen: false,
      query: "abc",
      isPending: true,
      matchCount: 0,
      selectedIndex: -1,
    });
  });

  it("notifies subscribers on registration, focus changes, and unregistration", () => {
    const listener = vi.fn();
    controller.subscribe(listener);

    const adapter = makeAdapter();
    const unregister = controller.register("pane-a", adapter);
    expect(listener).toHaveBeenCalledTimes(1);

    controller.setFocusedPane("pane-a");
    expect(listener).toHaveBeenCalledTimes(2);

    // Setting the same focused pane again is a no-op — no extra notify.
    controller.setFocusedPane("pane-a");
    expect(listener).toHaveBeenCalledTimes(2);

    unregister();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("stops notifying an unsubscribed listener", () => {
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();

    controller.register("pane-a", makeAdapter());

    expect(listener).not.toHaveBeenCalled();
  });
});
