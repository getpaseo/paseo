import { useLayoutEffect } from "react";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { useWorkspaceLayoutStore, type WorkspaceLayoutMode } from "@/stores/workspace-layout-store";

function resolveWorkspaceLayoutMode(isCompact: boolean): WorkspaceLayoutMode {
  if (isCompact) return "compact";
  return supportsDesktopPaneSplits() ? "split-panes" : "single-pane";
}

/**
 * Publishes the shell's workspace layout to the layout store, which decides where opened targets
 * land. Render it before the routes: React runs an earlier sibling's layout effects before a later
 * sibling's subtree, so a route sees the mode even from its first layout effect.
 */
export function WorkspaceLayoutModePublisher(): null {
  const isCompact = useIsCompactFormFactor();
  useLayoutEffect(() => {
    useWorkspaceLayoutStore.getState().setLayoutMode(resolveWorkspaceLayoutMode(isCompact));
  }, [isCompact]);
  return null;
}
