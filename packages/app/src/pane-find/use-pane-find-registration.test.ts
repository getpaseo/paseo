// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { paneFindController } from "./pane-find-controller";
import type { PaneFindAdapter } from "./pane-find-types";
import { usePaneFindRegistration } from "./use-pane-find-registration";

function makeAdapter(): PaneFindAdapter {
  return {
    hasCustomUI: false,
    getState: () => ({
      isOpen: false,
      query: "",
      isPending: false,
      matchCount: 0,
      selectedIndex: -1,
    }),
    subscribe: () => () => {},
    open: () => {},
    close: () => {},
    setQuery: () => {},
    selectNext: () => {},
    selectPrev: () => {},
  };
}

// Focus ownership is managed centrally (WorkspacePaneContent), not by this hook.
// Reset the singleton's focused pane between tests so assertions don't leak.
beforeEach(() => {
  const current = paneFindController.getFocusedPane();
  if (current) {
    paneFindController.clearFocusedPaneIfCurrent(current);
  }
});

describe("usePaneFindRegistration", () => {
  it("registers the adapter while mounted, and unregisters on unmount", () => {
    const adapter = makeAdapter();
    const paneKey = "test-pane:register-unregister";

    const { unmount } = renderHook(() => usePaneFindRegistration({ paneKey, adapter }));

    // The hook only registers the adapter; focus is set externally (centrally).
    paneFindController.setFocusedPane(paneKey);
    expect(paneFindController.getActiveAdapter()).toBe(adapter);

    unmount();

    // Adapter is gone; the focused key remains but resolves to no adapter.
    expect(paneFindController.getActiveAdapter()).toBeNull();
  });

  it("does not register anything when the pane key is null", () => {
    const adapter = makeAdapter();

    renderHook(() => usePaneFindRegistration({ paneKey: null, adapter }));

    paneFindController.setFocusedPane("test-pane:null-key");
    expect(paneFindController.getActiveAdapter()).toBeNull();
  });

  it("keeps find ownership when the adapter is swapped for the same pane key", () => {
    // Central focus is not cleared when a pane recreates its adapter (e.g. a tab
    // retargeted to a new agent); openActive() must keep reaching the pane.
    const adapterA = makeAdapter();
    const adapterB = makeAdapter();
    const paneKey = "test-pane:adapter-swap";

    const { rerender, unmount } = renderHook(
      ({ adapter }: { adapter: PaneFindAdapter }) => usePaneFindRegistration({ paneKey, adapter }),
      { initialProps: { adapter: adapterA } },
    );

    paneFindController.setFocusedPane(paneKey);
    expect(paneFindController.getActiveAdapter()).toBe(adapterA);

    rerender({ adapter: adapterB });

    expect(paneFindController.getFocusedPane()).toBe(paneKey);
    expect(paneFindController.getActiveAdapter()).toBe(adapterB);
    expect(paneFindController.openActive()).toBe(true);

    unmount();
  });
});
