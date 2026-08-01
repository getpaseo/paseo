import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";

export type ProjectStatusBadgeContent =
  | { kind: "loader" }
  | { kind: "alert" }
  | { kind: "dot"; bucket: "failed" | "attention" };

/**
 * What the collapsed-project status badge should render for a project's aggregate bucket,
 * or null when no badge should show at all. Kept as plain data (no React) so it's testable
 * without JSDOM or component mounting — see docs/testing.md's two test categories.
 *
 * The "dot" variant is narrowed to failed/attention only: running renders the loader and
 * needs_input renders the alert, so those two buckets can never reach a dot.
 */
export function getProjectStatusBadgeContent(
  statusBucket: SidebarStateBucket | null,
): ProjectStatusBadgeContent | null {
  if (shouldRenderSyncedStatusLoader({ bucket: statusBucket })) {
    return { kind: "loader" };
  }
  if (statusBucket === "needs_input") {
    return { kind: "alert" };
  }
  if (statusBucket === "failed" || statusBucket === "attention") {
    return { kind: "dot", bucket: statusBucket };
  }
  return null;
}
