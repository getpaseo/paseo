import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
}));

vi.mock("expo-router", () => ({
  router: {
    navigate: navigateMock,
  },
}));

import { navigateToWorkspace } from "@/hooks/use-workspace-navigation";
import {
  activateNavigationWorkspaceSelection,
  getNavigationActiveWorkspaceSelection,
  syncNavigationActiveWorkspace,
} from "@/stores/navigation-active-workspace-store";

describe("navigateToWorkspace", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    syncNavigationActiveWorkspace({ current: null });
  });

  it("uses router navigation from a non-workspace route even when active selection is stale", () => {
    activateNavigationWorkspaceSelection({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });

    navigateToWorkspace("server-1", "workspace-b", {
      currentPathname: "/h/server-1/sessions",
    });

    expect(navigateMock).toHaveBeenCalledWith("/h/server-1/workspace/workspace-b");
    expect(getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
  });

  it("keeps retained workspace switching on a workspace route", () => {
    activateNavigationWorkspaceSelection({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });

    navigateToWorkspace("server-1", "workspace-b", {
      currentPathname: "/h/server-1/workspace/workspace-a",
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(getNavigationActiveWorkspaceSelection()).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-b",
    });
  });
});
