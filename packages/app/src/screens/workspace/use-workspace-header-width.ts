import { useContext } from "react";
import { useStore } from "zustand";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import { WindowLayoutContentAllocationContext } from "@/window-layout/context";
import { useSidebarResizeGeometry } from "@/window-layout/sidebar-resize-geometry";

export interface WorkspaceHeaderGeometry {
  workspaceKey: string | null;
  containerWidth: number;
  explorer: { requestedWidth: number | undefined; containerWidth: number } | null;
}

export function useWorkspaceHeaderWidth(geometry: WorkspaceHeaderGeometry) {
  const allocation = useContext(WindowLayoutContentAllocationContext);
  const { store, viewportWidth } = useSidebarResizeGeometry();
  const active = allocation?.workspaceKey === geometry.workspaceKey;
  const leftDockWidth = active ? (allocation?.leftDockWidth ?? 0) : 0;
  const leftWidth = useStore(store, (state) =>
    leftDockWidth > 0 && state.left?.viewportWidth === viewportWidth ? state.left.width : null,
  );
  const explorerWidth = useStore(store, (state) =>
    active &&
    geometry.explorer &&
    state.explorer?.viewportWidth === viewportWidth &&
    state.explorer.workspaceKey === geometry.workspaceKey &&
    state.explorer.containerWidth === geometry.explorer.containerWidth
      ? state.explorer.width
      : null,
  );
  const containerWidth = Math.max(
    0,
    geometry.containerWidth + (leftWidth === null ? 0 : leftDockWidth - leftWidth),
  );
  if (!geometry.explorer) return containerWidth;
  return Math.max(
    0,
    containerWidth -
      resolveExplorerSidebarWidth({
        requestedWidth: explorerWidth ?? geometry.explorer.requestedWidth,
        containerWidth,
      }),
  );
}
