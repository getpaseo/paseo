import { useMemo } from "react";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupItem,
  type SidebarGroupVisibility,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

const PINNED_POLICY = { kind: "pinned" } as const;

interface LimitedSidebarGroupInput<T> {
  items: readonly T[];
  selection: ActiveWorkspaceSelection | null;
  /**
   * Whether the user revealed the whole group. The caller owns it: a native drop remounts the
   * rows it moved, and a reveal held inside a row would reset with them.
   */
  expanded: boolean;
  policy?: SidebarGroupVisibilityPolicy<T>;
}

export function useLimitedSidebarGroup<T extends SidebarGroupItem>({
  items,
  selection,
  expanded,
  policy = PINNED_POLICY,
}: LimitedSidebarGroupInput<T>): SidebarGroupVisibility<T> {
  return useMemo(
    () => selectSidebarGroupVisibility({ items, expanded, policy, selection }),
    [expanded, items, policy, selection],
  );
}
