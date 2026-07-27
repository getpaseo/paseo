/**
 * Claim a draft auto-submit key before starting createAgent.
 * Prevents concurrent effect runs (remount / dependency thrash) from creating
 * two agents for the same pending New Workspace submission.
 */
const claimedKeys = new Set<string>();

export function claimDraftAutoSubmit(key: string): boolean {
  if (claimedKeys.has(key)) {
    return false;
  }
  claimedKeys.add(key);
  return true;
}

export function releaseDraftAutoSubmit(key: string): void {
  claimedKeys.delete(key);
}

/** Test helper only. */
export function resetDraftAutoSubmitClaimsForTests(): void {
  claimedKeys.clear();
}
