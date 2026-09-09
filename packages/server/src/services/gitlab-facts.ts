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

export type GitLabForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "gitlab";
} & GitLabStatusFacts;

export function isGitLabStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is GitLabForgeSpecificStatusFacts {
  return facts?.forge === "gitlab";
}
