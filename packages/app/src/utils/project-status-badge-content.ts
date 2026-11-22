import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type ProjectStatusBadgeDotBucket = "failed" | "attention" | "running" | "needs_follow_up";

export type ProjectStatusBadgeContent =
  | { kind: "alert" }
  | { kind: "dot"; bucket: ProjectStatusBadgeDotBucket };

export function getProjectStatusBadgeContent(
  statusBucket: SidebarStateBucket | null,
): ProjectStatusBadgeContent | null {
  if (!statusBucket || statusBucket === "done") return null;
  if (statusBucket === "needs_input") return { kind: "alert" };
  return { kind: "dot", bucket: statusBucket };
}
