import { useCallback, useMemo, useState } from "react";
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
  policy?: SidebarGroupVisibilityPolicy<T>;
}

export function useLimitedSidebarGroup<T extends SidebarGroupItem>({
  items,
  selection,
  policy = PINNED_POLICY,
}: LimitedSidebarGroupInput<T>): SidebarGroupVisibility<T> & {
  expanded: boolean;
  toggleExpanded: () => void;
} {
  const [expanded, setExpanded] = useState(false);
  const visibility = useMemo(
    () => selectSidebarGroupVisibility({ items, expanded, policy, selection }),
    [expanded, items, policy, selection],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { ...visibility, expanded, toggleExpanded };
}

/**
 * A section's rows. Same limit as a project's rows, but the open workspace is only pulled above the
 * limit while the route can select a row: outside a workspace route nothing highlights, so a row
 * the limit hides must not reappear for a selection that cannot be shown.
 */
export function useSidebarSectionGroup<T extends SidebarGroupItem>({
  items,
  selection,
  selectionEnabled,
  policy = PINNED_POLICY,
}: LimitedSidebarGroupInput<T> & { selectionEnabled: boolean }) {
  return useLimitedSidebarGroup({
    items,
    selection: selectionEnabled ? selection : null,
    policy,
  });
}
