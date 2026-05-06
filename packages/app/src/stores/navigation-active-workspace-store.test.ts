/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({
  dismissTo: vi.fn(),
}));
const pathnameState = vi.hoisted(() => ({
  value: "/",
}));
const localParamsState = vi.hoisted(() => ({
  value: {} as { serverId?: string | string[]; workspaceId?: string | string[] },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  useLocalSearchParams: () => localParamsState.value,
  usePathname: () => pathnameState.value,
}));

import {
  navigateToLastWorkspace,
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

describe("workspace navigation", () => {
  beforeEach(() => {
    routerMock.dismissTo.mockReset();
    pathnameState.value = "/";
    localParamsState.value = {};
  });

  it("reports when no last workspace is known", () => {
    expect(navigateToLastWorkspace()).toBe(false);
  });

  it("navigates to a workspace route", () => {
    navigateToWorkspace("server-1", "workspace-a");

    expect(routerMock.dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });

  it("reads the active workspace from the current route", () => {
    pathnameState.value = "/h/server-1/workspace/workspace-a";

    const { result } = renderHook(() => useActiveWorkspaceSelection());

    expect(result.current).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
    });
  });

  it("falls back to workspace route params during cold route mount", () => {
    localParamsState.value = {
      serverId: "server-1",
      workspaceId: "b64_L3RtcC9wYXNlby1taXNzaW5nLXdvcmtzcGFjZQ",
    };

    const { result } = renderHook(() => useActiveWorkspaceSelection());

    expect(result.current).toEqual({
      serverId: "server-1",
      workspaceId: "/tmp/paseo-missing-workspace",
    });
  });

  it("navigates to the last workspace observed by the route reader", () => {
    pathnameState.value = "/h/server-1/workspace/workspace-a";
    renderHook(() => useActiveWorkspaceSelection());

    expect(navigateToLastWorkspace()).toBe(true);
    expect(routerMock.dismissTo).toHaveBeenCalledWith("/h/server-1/workspace/workspace-a");
  });
});
