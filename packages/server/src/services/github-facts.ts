import type { ForgeSpecificStatusFacts } from "./forge-service.js";

export interface GitHubPullRequestStatusFacts {
  mergeStateStatus: string | null;
  autoMergeRequest: {
    enabledAt: string | null;
    mergeMethod: string | null;
    enabledBy: string | null;
  } | null;
  viewerCanEnableAutoMerge: boolean;
  viewerCanDisableAutoMerge: boolean;
  viewerCanMergeAsAdmin: boolean;
  viewerCanUpdateBranch: boolean;
  repository: {
    autoMergeAllowed: boolean;
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    viewerDefaultMergeMethod: string | null;
  };
  isMergeQueueEnabled: boolean;
  isInMergeQueue: boolean;
}

export type GitHubForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "github";
} & GitHubPullRequestStatusFacts;

export function isGitHubPullRequestStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is GitHubForgeSpecificStatusFacts {
  return facts?.forge === "github";
}
