import { createContext, useContext, type ReactNode } from "react";
import type { RecentlyDoneRecency } from "@/hooks/sidebar-status-view-model";
import { useRecentlyDoneRecency } from "./use-recently-done-recency";

const SidebarRecencyContext = createContext<RecentlyDoneRecency | undefined>(undefined);

export function SidebarRecencyProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const recency = useRecentlyDoneRecency(active);
  return (
    <SidebarRecencyContext.Provider value={recency}>{children}</SidebarRecencyContext.Provider>
  );
}

export function useSidebarRecency(): RecentlyDoneRecency | undefined {
  return useContext(SidebarRecencyContext);
}
