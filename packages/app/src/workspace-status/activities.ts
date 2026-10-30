import type { WorkspaceActivity } from "@getpaseo/protocol/messages";
import {
  getWorkspaceStateBucketPriority,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";

export interface WorkspaceActivitySource {
  status: WorkspaceStateBucket;
  activities?: readonly WorkspaceActivity[];
  primaryActivityId?: string | null;
}

export function primaryWorkspaceActivity(
  source: WorkspaceActivitySource,
): WorkspaceActivity | null {
  return (
    source.activities?.find(
      (activity) => activity.id === source.primaryActivityId && activity.status === source.status,
    ) ?? null
  );
}

/** Preserve concurrent activity; a higher-priority native signal always owns the primary mark. */
export function summarizeWorkspaceActivities(sources: readonly WorkspaceActivitySource[]): {
  primary: WorkspaceActivity | null;
  activities: WorkspaceActivity[];
  count: number;
} {
  const activities = sources.flatMap((source) => source.activities ?? []);
  const bestPriority = Math.min(
    ...sources.map((source) => getWorkspaceStateBucketPriority(source.status)),
  );
  const winners = sources.filter(
    (source) => getWorkspaceStateBucketPriority(source.status) === bestPriority,
  );
  const primary =
    winners.length && winners.every((source) => primaryWorkspaceActivity(source))
      ? primaryWorkspaceActivity(winners[0])
      : null;
  return {
    primary,
    activities,
    count: activities.reduce((total, activity) => total + (activity.count ?? 1), 0),
  };
}

export function workspaceActivityLabel(activity: WorkspaceActivity): string {
  return activity.count && activity.count > 1
    ? `${activity.label} · ${activity.count}`
    : activity.label;
}
