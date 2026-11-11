import type { SidebarStateBucket } from "@/hooks/sidebar-workspaces-view-model";

export type SidebarGroupVisibilityPolicy<T> =
  | { kind: "pinned" }
  | { kind: "workspaces"; getStatusBucket: (item: T) => SidebarStateBucket };

export function selectSidebarGroupVisibility<T>(
  items: readonly T[],
  expanded: boolean,
  policy: SidebarGroupVisibilityPolicy<T>,
) {
  const limit = policy.kind === "pinned" ? 20 : 7;
  const baseline = items.filter(
    (item, index) =>
      index < limit || (policy.kind === "workspaces" && policy.getStatusBucket(item) !== "done"),
  );
  return {
    visibleItems: expanded ? items.slice() : baseline,
    canToggle: baseline.length < items.length,
  };
}
