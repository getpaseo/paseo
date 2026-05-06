/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const navigateToWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: navigateToWorkspaceMock,
}));

import { navigateToWorkspace, useWorkspaceNavigation } from "@/hooks/use-workspace-navigation";

describe("useWorkspaceNavigation", () => {
  it("re-exports the workspace navigation action", () => {
    expect(navigateToWorkspace).toBe(navigateToWorkspaceMock);
  });

  it("returns a stable callback wrapper", () => {
    const { result } = renderHook(() => useWorkspaceNavigation());

    result.current.navigateToWorkspace("server-1", "workspace-a");

    expect(navigateToWorkspaceMock).toHaveBeenCalledWith("server-1", "workspace-a", undefined);
  });
});
