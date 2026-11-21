import type { CheckoutGitActionStatus } from "@/git/actions-store";

function isAnyStatusPending(statuses: CheckoutGitActionStatus[]): boolean {
  return statuses.includes("pending");
}

// commit-and-push spans a commit and a push RPC. While it's pending, every
// other mutation on the checkout is disabled (`otherActionsDisabled`); while
// any of those is pending, commit-and-push is disabled in turn
// (`isOtherMutationPending`) so neither side can race the other.
export function computeCommitAndPushMutex(input: {
  actionsDisabled: boolean;
  commitAndPushStatus: CheckoutGitActionStatus;
  otherStatuses: CheckoutGitActionStatus[];
  isArchiving: boolean;
}): { otherActionsDisabled: boolean; isOtherMutationPending: boolean } {
  return {
    otherActionsDisabled: input.actionsDisabled || input.commitAndPushStatus === "pending",
    isOtherMutationPending: isAnyStatusPending(input.otherStatuses) || input.isArchiving,
  };
}
