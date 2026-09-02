/**
 * Canonical set of GitLab pipeline/job statuses that count as "still active"
 * (not yet terminal). Shared by the daemon (merge-capability facts, checks
 * aggregation) and the app (pipeline presentation) so a new GitLab transitional
 * status only needs to be added in one place.
 */
export const GITLAB_ACTIVE_PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "canceling",
  "scheduled",
] as const;

export type GitLabActivePipelineStatus = (typeof GITLAB_ACTIVE_PIPELINE_STATUSES)[number];

export const GITLAB_ACTIVE_PIPELINE_STATUS_SET = new Set<string>(GITLAB_ACTIVE_PIPELINE_STATUSES);
