import { useCallback } from "react";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";

/**
 * Whether the sidebar footer shows the Usage summary: the same switch as Settings > Sidebar.
 * Window rows pin to the summary only while it is on.
 */
export function useUsageInSidebar(): {
  inSidebar: boolean;
  setInSidebar: (visible: boolean) => void;
} {
  const { items, setVisible } = useSidebarNavItems("footer");
  const inSidebar = items.some((item) => item.key === "usage" && item.visible);
  const setInSidebar = useCallback(
    (visible: boolean) => setVisible("usage", visible),
    [setVisible],
  );
  return { inSidebar, setInSidebar };
}
