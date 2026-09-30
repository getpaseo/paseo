import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

/** The open workspace scrolls into view, so a long sidebar never hides where you are. */
export function useScrollSelectedRowIntoView(selected: boolean, workspaceKey: string): void {
  useEffect(() => {
    if (!isWeb || !selected) return undefined;
    // On first load the sidebar keeps laying out after the row mounts; scroll once it settled.
    const timer = setTimeout(() => {
      const row = document.querySelector(
        `[data-testid="sidebar-workspace-row-${window.CSS.escape(workspaceKey)}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
    }, 400);
    return () => clearTimeout(timer);
  }, [selected, workspaceKey]);
}
