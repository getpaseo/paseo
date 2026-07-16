// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { paneFindController } from "./pane-find-controller";
import type { PaneFindAdapter } from "./pane-find-types";
import { useGlobalPaneFindAction } from "./use-global-pane-find-action";

function makeAdapter(): PaneFindAdapter & { open: () => void } {
  let opened = false;
  return {
    hasCustomUI: false,
    getState: () => ({
      isOpen: opened,
      query: "",
      isPending: false,
      matchCount: 0,
      selectedIndex: -1,
    }),
    subscribe: () => () => {},
    open: () => {
      opened = true;
    },
    close: () => {
      opened = false;
    },
    setQuery: () => {},
    selectNext: () => {},
    selectPrev: () => {},
  };
}

describe("useGlobalPaneFindAction", () => {
  it("dispatching workspace.find.open toggles the currently focused pane's adapter", () => {
    const { unmount } = renderHook(() => useGlobalPaneFindAction());

    const adapter = makeAdapter();
    const paneKey = "test-pane:global-action";
    const unregister = paneFindController.register(paneKey, adapter);
    paneFindController.setFocusedPane(paneKey);

    expect(adapter.getState().isOpen).toBe(false);

    const handled = keyboardActionDispatcher.dispatch({
      id: "workspace.find.open",
      scope: "workspace",
    });

    expect(handled).toBe(true);
    expect(adapter.getState().isOpen).toBe(true);

    const handledAgain = keyboardActionDispatcher.dispatch({
      id: "workspace.find.open",
      scope: "workspace",
    });
    expect(handledAgain).toBe(true);
    expect(adapter.getState().isOpen).toBe(false);

    unregister();
    unmount();
  });

  it("returns false when no pane is focused, so the dispatcher reports it unhandled", () => {
    const { unmount } = renderHook(() => useGlobalPaneFindAction());

    const handled = keyboardActionDispatcher.dispatch({
      id: "workspace.find.open",
      scope: "workspace",
    });

    expect(handled).toBe(false);

    unmount();
  });

  it("stops handling the action once unmounted", () => {
    const { unmount } = renderHook(() => useGlobalPaneFindAction());
    unmount();

    const handled = keyboardActionDispatcher.dispatch({
      id: "workspace.find.open",
      scope: "workspace",
    });

    expect(handled).toBe(false);
  });
});
