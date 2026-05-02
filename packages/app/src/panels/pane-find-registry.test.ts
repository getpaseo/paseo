import { describe, expect, it, vi } from "vitest";

import {
  clearActivePaneFindPaneId,
  createPaneFindRegistry,
  handlePaneFindKeyboardAction,
  paneFindRegistry,
  setActivePaneFindPaneId,
  type PaneFindController,
} from "@/panels/pane-find-registry";

function createController(input?: { openResult?: boolean }): PaneFindController {
  return {
    openFind: vi.fn(() => input?.openResult ?? true),
    closeFind: vi.fn(() => true),
  };
}

describe("pane find registry", () => {
  it("routes open find to the active pane instance", () => {
    const activePaneId = { current: "server:workspace:left" };
    const registry = createPaneFindRegistry({
      getActivePaneId: () => activePaneId.current,
    });
    const left = createController({ openResult: false });
    const right = createController({ openResult: true });

    registry.register({
      paneId: "server:workspace:left",
      controller: left,
    });
    registry.register({
      paneId: "server:workspace:right",
      controller: right,
    });

    expect(registry.openFindInActivePane()).toBe(false);
  });

  it("stops routing to a pane after it unregisters", () => {
    const registry = createPaneFindRegistry({
      getActivePaneId: () => "server:workspace:left",
    });
    const controller = createController();

    const unregister = registry.register({
      paneId: "server:workspace:left",
      controller,
    });
    unregister();

    expect(registry.openFindInActivePane()).toBe(false);
    expect(controller.closeFind).toHaveBeenCalledTimes(1);
  });

  it("keeps split panes with the same target distinct by pane instance", () => {
    const activePaneId = { current: "server:workspace:right" };
    const registry = createPaneFindRegistry({
      getActivePaneId: () => activePaneId.current,
    });
    const left = createController({ openResult: false });
    const right = createController({ openResult: true });

    registry.register({
      paneId: "server:workspace:left",
      controller: left,
    });
    registry.register({
      paneId: "server:workspace:right",
      controller: right,
    });

    expect(registry.openFindInActivePane()).toBe(true);
  });

  it("handles the keyboard find action through the active pane", () => {
    const controller = createController();
    const unregister = paneFindRegistry.register({
      paneId: "server:workspace:left",
      controller,
    });
    setActivePaneFindPaneId("server:workspace:left");

    expect(handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" })).toBe(
      true,
    );
    expect(controller.openFind).toHaveBeenCalledTimes(1);

    clearActivePaneFindPaneId("server:workspace:left");
    expect(controller.closeFind).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("closes the previous active pane when pane focus changes", () => {
    const left = createController();
    const right = createController();
    const unregisterLeft = paneFindRegistry.register({
      paneId: "server:workspace:left",
      controller: left,
    });
    const unregisterRight = paneFindRegistry.register({
      paneId: "server:workspace:right",
      controller: right,
    });

    setActivePaneFindPaneId("server:workspace:left");
    setActivePaneFindPaneId("server:workspace:right");

    expect(left.closeFind).toHaveBeenCalledTimes(1);
    expect(right.closeFind).not.toHaveBeenCalled();

    clearActivePaneFindPaneId("server:workspace:right");
    unregisterLeft();
    unregisterRight();
  });
});
