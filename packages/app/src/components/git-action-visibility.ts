export function shouldShowMergeFromBaseAction(input: {
  isOnBaseBranch: boolean;
  hasRemote: boolean;
  aheadOfOrigin: number;
  behindOfOrigin: number;
}): boolean {
  if (!input.isOnBaseBranch) {
    return true;
  }
  if (!input.hasRemote) {
    return false;
  }
  return input.aheadOfOrigin > 0 || input.behindOfOrigin > 0;
}
