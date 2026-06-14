import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";

export type PickerItem =
  | { kind: "new-branch" }
  | { kind: "branch"; name: string }
  | {
      kind: "github-pr";
      item: GitHubSearchItem;
    };

export type PickerCheckoutRequest = Pick<
  CreatePaseoWorktreeInput,
  "action" | "refName" | "githubPrNumber"
>;

export interface NewWorkspaceCheckoutResolution {
  checkoutRequest?: PickerCheckoutRequest;
  worktreeSlug?: string;
}

export function pickerItemToCheckoutRequest(
  item: PickerItem | null,
): PickerCheckoutRequest | undefined {
  if (!item) return undefined;
  switch (item.kind) {
    case "new-branch":
      return undefined;
    case "branch":
      return { action: "branch-off", refName: item.name };
    case "github-pr":
      return {
        action: "checkout",
        refName: item.item.headRefName ?? "",
        githubPrNumber: item.item.number,
      };
  }
}

export function resolveNewWorkspaceCheckoutRequest(input: {
  selectedItem: PickerItem | null;
  currentBranch: string | null;
  newBranchSlug?: string | null;
}): NewWorkspaceCheckoutResolution {
  const newBranchSlug = input.newBranchSlug?.trim();
  if (newBranchSlug) {
    const baseRefName =
      input.selectedItem?.kind === "branch" ? input.selectedItem.name : input.currentBranch;
    return {
      worktreeSlug: newBranchSlug,
      ...(baseRefName
        ? {
            checkoutRequest: {
              action: "branch-off",
              refName: baseRefName,
            },
          }
        : {}),
    };
  }

  const checkoutRequest = pickerItemToCheckoutRequest(input.selectedItem);
  if (checkoutRequest) return { checkoutRequest };
  if (!input.currentBranch) return {};
  return {
    checkoutRequest: {
      action: "branch-off",
      refName: input.currentBranch,
    },
  };
}
