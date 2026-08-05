import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type ProjectStatusBadgeDotBucket = "failed" | "attention" | "running";

export type ProjectStatusBadgeContent =
  | { kind: "alert" }
  | { kind: "dot"; bucket: ProjectStatusBadgeDotBucket };

/**
 * What the project status badge should render for a project's aggregate bucket, or null when
 * no badge should show at all. Kept as plain data (no React) so it's testable without JSDOM
 * or component mounting — see docs/testing.md's two test categories.
 *
 * Running is a dot like failed and attention rather than its own glyph. The badge is 14pt;
 * anything with internal detail at that size loses to a solid disc, so the buckets separate
 * by color and — for running alone — by pulsing. Only needs_input earns a glyph, because
 * "someone must act" has to survive being the one amber state next to running.
 */
export function getProjectStatusBadgeContent(
  statusBucket: SidebarStateBucket | null,
): ProjectStatusBadgeContent | null {
  if (statusBucket === "needs_input") {
    return { kind: "alert" };
  }
  if (statusBucket === "failed" || statusBucket === "attention" || statusBucket === "running") {
    return { kind: "dot", bucket: statusBucket };
  }
  return null;
}
