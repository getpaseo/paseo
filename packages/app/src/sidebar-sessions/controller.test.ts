/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSidebarSessionsController } from "./controller";

describe("useSidebarSessionsController", () => {
  it("starts with project grouping off and no expanded projects", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    expect(result.current.groupByProject).toBe(false);
    expect(result.current.previewExpandedProjects.size).toBe(0);
  });

  it("enables project grouping without expanding projects", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    act(() => {
      result.current.setGroupByProject(true);
    });

    expect(result.current.groupByProject).toBe(true);
    expect(result.current.previewExpandedProjects.size).toBe(0);
  });

  it("toggles one expanded project", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    act(() => {
      result.current.toggleProjectPreviewExpanded("p1");
    });

    expect(result.current.previewExpandedProjects.has("p1")).toBe(true);

    act(() => {
      result.current.toggleProjectPreviewExpanded("p1");
    });

    expect(result.current.previewExpandedProjects.size).toBe(0);
  });

  it("toggles expanded projects independently", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    act(() => {
      result.current.toggleProjectPreviewExpanded("p1");
      result.current.toggleProjectPreviewExpanded("p2");
    });

    expect([...result.current.previewExpandedProjects].sort()).toEqual(["p1", "p2"]);

    act(() => {
      result.current.toggleProjectPreviewExpanded("p1");
    });

    expect([...result.current.previewExpandedProjects]).toEqual(["p2"]);
  });

  it("clears expanded projects when project grouping is disabled", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    act(() => {
      result.current.setGroupByProject(true);
      result.current.toggleProjectPreviewExpanded("p1");
    });

    expect(result.current.previewExpandedProjects.has("p1")).toBe(true);

    act(() => {
      result.current.setGroupByProject(false);
    });

    expect(result.current.groupByProject).toBe(false);
    expect(result.current.previewExpandedProjects.size).toBe(0);
  });

  it("resets the session filter when the active host changes", () => {
    const { result, rerender } = renderHook(
      ({ serverId }) => useSidebarSessionsController({ serverId }),
      { initialProps: { serverId: "server-1" as string | null } },
    );

    act(() => {
      result.current.setSidebarSessionFilter({
        type: "project",
        projectKey: "project-a",
      });
    });

    expect(result.current.sidebarSessionFilter).toEqual({
      type: "project",
      projectKey: "project-a",
    });

    rerender({ serverId: "server-2" });

    expect(result.current.sidebarSessionFilter).toEqual({ type: "all" });
    expect(result.current.sidebarViewMode).toBe("workspaces");
  });

  it("clears expanded projects when the active host changes", () => {
    const { result, rerender } = renderHook(
      ({ serverId }) => useSidebarSessionsController({ serverId }),
      { initialProps: { serverId: "server-1" as string | null } },
    );

    act(() => {
      result.current.setGroupByProject(true);
      result.current.toggleProjectPreviewExpanded("p1");
    });

    expect(result.current.previewExpandedProjects.has("p1")).toBe(true);

    rerender({ serverId: "server-2" });

    expect(result.current.previewExpandedProjects.size).toBe(0);
  });

  it("clears expanded projects when the session filter changes", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    act(() => {
      result.current.setGroupByProject(true);
      result.current.toggleProjectPreviewExpanded("p1");
    });

    expect(result.current.previewExpandedProjects.has("p1")).toBe(true);

    act(() => {
      result.current.setSidebarSessionFilter({
        type: "project",
        projectKey: "project-a",
      });
    });

    expect(result.current.sidebarSessionFilter).toEqual({
      type: "project",
      projectKey: "project-a",
    });
    expect(result.current.previewExpandedProjects.size).toBe(0);
  });

  it("does not clear the session filter when project grouping is enabled", () => {
    const { result } = renderHook(() => useSidebarSessionsController({ serverId: "server-1" }));

    act(() => {
      result.current.setSidebarSessionFilter({
        type: "project",
        projectKey: "project-a",
      });
    });

    act(() => {
      result.current.setGroupByProject(true);
    });

    expect(result.current.groupByProject).toBe(true);
    expect(result.current.sidebarSessionFilter).toEqual({
      type: "project",
      projectKey: "project-a",
    });
  });

  it("preserves project grouping when the active host changes", () => {
    const { result, rerender } = renderHook(
      ({ serverId }) => useSidebarSessionsController({ serverId }),
      { initialProps: { serverId: "server-1" as string | null } },
    );

    act(() => {
      result.current.setGroupByProject(true);
    });

    rerender({ serverId: "server-2" });

    expect(result.current.groupByProject).toBe(true);
  });
});
