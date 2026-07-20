import { describe, expect, it, vi } from "vitest";
import { createPaneFindController } from "./pane-find-controller";
import {
  handlePaneFindInputKey,
  normalizePaneFindQuery,
  registerPaneFindAdapter,
  toggleActivePaneFind,
} from "./pane-find-helpers";
import type { PaneFindAdapter } from "./pane-find-types";

function createAdapter(): PaneFindAdapter {
  let isOpen = false;
  return {
    hasCustomUI: false,
    getState: () => ({ isOpen, query: "", isPending: false, matchCount: 0, selectedIndex: -1 }),
    subscribe: () => () => {},
    open: () => {
      isOpen = true;
    },
    close: () => {
      isOpen = false;
    },
    setQuery: () => {},
    selectNext: () => {},
    selectPrev: () => {},
  };
}

describe("pane find helpers", () => {
  it("normalizes queries before forwarding them to adapters", () => {
    expect(normalizePaneFindQuery("  needle  ")).toBe("needle");
    expect(normalizePaneFindQuery("   ")).toBe("");
  });

  it("routes Enter, Shift+Enter, and Escape to their pane-find operations", () => {
    const onClose = vi.fn();
    const onSelectNext = vi.fn();
    const onSelectPrev = vi.fn();
    const input = { onClose, onSelectNext, onSelectPrev };

    handlePaneFindInputKey({ ...input, key: "Enter" });
    handlePaneFindInputKey({ ...input, key: "Enter", shiftKey: true });
    handlePaneFindInputKey({ ...input, key: "Escape" });

    expect(onSelectNext).toHaveBeenCalledTimes(1);
    expect(onSelectPrev).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toggles only the focused pane's find adapter", () => {
    const controller = createPaneFindController();
    const adapter = createAdapter();
    registerPaneFindAdapter({ controller, paneKey: "pane", adapter });
    controller.setFocusedPane("pane");

    expect(toggleActivePaneFind(controller)).toBe(true);
    expect(adapter.getState().isOpen).toBe(true);
    expect(toggleActivePaneFind(controller)).toBe(true);
    expect(adapter.getState().isOpen).toBe(false);
  });

  it("does nothing when no pane is focused and unregisters by cleanup", () => {
    const controller = createPaneFindController();
    const adapter = createAdapter();
    expect(toggleActivePaneFind(controller)).toBe(false);

    const unregister = registerPaneFindAdapter({ controller, paneKey: "pane", adapter });
    controller.setFocusedPane("pane");
    expect(controller.getActiveAdapter()).toBe(adapter);
    unregister?.();
    expect(controller.getActiveAdapter()).toBeNull();
  });
});
