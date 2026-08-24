import type { ForgeSpecificStatusFacts } from "./forge-service.js";

export interface GitLabStatusFacts {
  detailedMergeStatus: string | null;
  /**
   * Legacy `merge_status` (pre-15.6 GitLab), used as the direct-merge readiness
   * signal when `detailedMergeStatus` is absent on older self-managed instances.
   */
  mergeStatus: string | null;
  hasConflicts: boolean;
  blockingDiscussionsResolved: boolean;
  approvalsRequired: number;
  approvalsGiven: number;
  pipelineStatus: string | null;
  /**
   * Id of the MR's head pipeline, used to fetch the full pipeline (stages ->
   * jobs) on demand. Null when the MR has no pipeline yet.
   */
  pipelineId: number | null;
  pipelineUrl: string | null;
  mergeWhenPipelineSucceeds: boolean;
}

// Client-side twin: packages/app/src/git/forges/gitlab.ts
// (GITLAB_ACTIVE_PIPELINE_STATUSES / isPipelineActiveStatus). Duplicated because
// the app can't depend on the server package; keep the two lists in sync by hand
// if GitLab adds a new active pipeline status.
export const GITLAB_ACTIVE_PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
] as const;

export type GitLabActivePipelineStatus = (typeof GITLAB_ACTIVE_PIPELINE_STATUSES)[number];

export const GITLAB_ACTIVE_PIPELINE_STATUS_SET = new Set<string>(GITLAB_ACTIVE_PIPELINE_STATUSES);

export type GitLabForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "gitlab";
} & GitLabStatusFacts;

export function isGitLabStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is GitLabForgeSpecificStatusFacts {
  return facts?.forge === "gitlab";
}
