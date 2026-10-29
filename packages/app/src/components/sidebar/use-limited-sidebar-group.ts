import { useCallback, useMemo, useState } from "react";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";

const PINNED_POLICY = { kind: "pinned" } as const;

export function useLimitedSidebarGroup<T>(
  items: readonly T[],
  policy: SidebarGroupVisibilityPolicy<T> = PINNED_POLICY,
) {
  const [expanded, setExpanded] = useState(false);
  const visibility = useMemo(
    () => selectSidebarGroupVisibility(items, expanded, policy),
    [expanded, items, policy],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { ...visibility, expanded, toggleExpanded };
}
