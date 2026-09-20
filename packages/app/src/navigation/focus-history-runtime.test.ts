import { describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({
  router: { navigate: vi.fn() },
  usePathname: () => "/",
}));

import { createDefaultLayout } from "@/stores/workspace-layout-store";
import { openTabInLayoutFocused } from "@/stores/workspace-layout-actions";
import {
  buildWorkspaceFocusLocation,
  restoreNavigationFocusLocation,
  type RestoreNavigationFocusLocationDeps,
} from "./focus-history-runtime";

function makeDeps(): RestoreNavigationFocusLocationDeps {
  return {
    navigateWorkspace: vi.fn(() => "/h/server-1/workspace/workspace-a"),
    navigateRoute: vi.fn(),
    focusPane: vi.fn(),
    focusTab: vi.fn(),
    restoreView: vi.fn(),
  };
}

describe("workspace focus locations", () => {
  it("captures the focused pane, tab target, and view", () => {
    const opened = openTabInLayoutFocused({
      layout: createDefaultLayout(),
      target: { kind: "agent", agentId: "agent-a" },
      now: 1,
    });

    expect(
      buildWorkspaceFocusLocation({
        serverId: "server-1",
        workspaceId: "workspace-a",
        layout: opened.layout,
        view: { panel: "file-explorer", explorerTab: "files" },
      }),
    ).toEqual({
      kind: "workspace",
      serverId: "server-1",
      workspaceId: "workspace-a",
      paneId: "main",
      tabId: "agent_agent-a",
      target: { kind: "agent", agentId: "agent-a" },
      view: { panel: "file-explorer", explorerTab: "files" },
    });
  });

  it("restores workspace routing before exact tab and panel focus", () => {
    const deps = makeDeps();
    restoreNavigationFocusLocation(
      {
        kind: "workspace",
        serverId: "server-1",
        workspaceId: "workspace-a",
        paneId: "pane-side",
        tabId: "agent_agent-a",
        target: { kind: "agent", agentId: "agent-a" },
        view: { panel: "agent", explorerTab: "changes" },
      },
      deps,
    );

    expect(deps.navigateWorkspace).toHaveBeenCalledWith({
      serverId: "server-1",
      workspaceId: "workspace-a",
      target: { kind: "agent", agentId: "agent-a" },
    });
    expect(deps.focusTab).toHaveBeenCalledWith("server-1:workspace-a", "agent_agent-a");
    expect(deps.focusPane).not.toHaveBeenCalled();
    expect(deps.restoreView).toHaveBeenCalledWith({ panel: "agent", explorerTab: "changes" });
  });

  it("restores non-workspace routes without changing workspace state", () => {
    const deps = makeDeps();

    restoreNavigationFocusLocation({ kind: "route", pathname: "/settings/general" }, deps);

    expect(deps.navigateRoute).toHaveBeenCalledWith("/settings/general");
    expect(deps.navigateWorkspace).not.toHaveBeenCalled();
    expect(deps.restoreView).not.toHaveBeenCalled();
  });
});
