import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type ProjectStatusBadgeDotBucket = "failed";

export type ProjectStatusBadgeContent =
  | { kind: "grid"; bucket: "running" }
  | { kind: "pulse"; bucket: "attention" | "needs_input" }
  | { kind: "dot"; bucket: ProjectStatusBadgeDotBucket };

/**
 * What the project status badge should render for a project's aggregate bucket, or null when
 * no badge should show at all. Kept as plain data (no React) so it's testable without JSDOM
 * or component mounting — see docs/testing.md's two test categories.
 *
 * The project badge uses the same activity grid and pulse rings as the workspace row.
 * Failures stay a static red dot; done has no badge.
 */
export function getProjectStatusBadgeContent(
  statusBucket: SidebarStateBucket | null,
): ProjectStatusBadgeContent | null {
  if (statusBucket === "needs_input") {
    return { kind: "pulse", bucket: "needs_input" };
  }
  if (statusBucket === "running") {
    return { kind: "grid", bucket: "running" };
  }
  if (statusBucket === "attention") {
    return { kind: "pulse", bucket: "attention" };
  }
  if (statusBucket === "failed") {
    return { kind: "dot", bucket: statusBucket };
  }
  return null;
}
