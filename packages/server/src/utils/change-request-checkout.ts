import type { PullRequestCheckoutRef } from "../services/forge-service.js";

// upstream for clones where origin is your fork
export function buildPullHeadCheckoutRefs(number: number): PullRequestCheckoutRef[] {
  return [
    { remoteName: "origin", remoteRef: `refs/pull/${number}/head` },
    { remoteName: "upstream", remoteRef: `refs/pull/${number}/head` },
  ];
}

// forgejo username pattern, covers github logins too
export function normalizeForgeOwnerForBranch(owner: string | null): string | null {
  const normalized = owner?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(normalized)) {
    return null;
  }
  // git refuses .. and .lock, trailing dot too
  if (normalized.includes("..") || normalized.endsWith(".") || normalized.endsWith(".lock")) {
    return null;
  }
  return normalized;
}

export interface ForkLocalBranchNameInput {
  headRef: string;
  number: number;
  isCrossRepository: boolean;
  headOwnerLogin: string | null;
}

export function buildForkLocalBranchName(params: ForkLocalBranchNameInput): string {
  if (!params.isCrossRepository) {
    return params.headRef;
  }
  const owner = normalizeForgeOwnerForBranch(params.headOwnerLogin);
  return `${owner ?? `pr-${params.number}`}/${params.headRef}`;
}
