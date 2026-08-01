import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { CheckoutStatusPayload } from "@/git/checkout-status-cache";

export interface BranchPickerDetail {
  name: string;
  committerDate: number;
  hasLocal?: boolean;
  hasRemote?: boolean;
  localAhead?: number;
  localBehind?: number;
}

export type PickerItem =
  | {
      kind: "branch";
      name: string;
      refName: string;
      accessibilityLabel: string;
      divergenceLabel?: string;
      committerDate?: number;
    }
  | {
      kind: "github-pr";
      item: ForgeSearchItem;
    };

export type PickerCheckoutRequest = Pick<
  CreatePaseoWorktreeInput,
  "action" | "refName" | "checkoutSource" | "githubPrNumber"
>;

const BRANCH_OPTION_PREFIX = "branch:";

export function branchPickerOptionId(refName: string): string {
  return `${BRANCH_OPTION_PREFIX}${refName}`;
}

function divergenceLabel(ahead: number, behind: number): string | undefined {
  const parts = [ahead > 0 ? `+${ahead}` : null, behind > 0 ? `−${behind}` : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function commitCount(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function divergenceAccessibility(ahead: number, behind: number, counterpart: string): string {
  if (ahead === 0 && behind === 0) {
    return `up to date with ${counterpart}`;
  }
  if (ahead > 0 && behind > 0) {
    return `${commitCount(ahead)} ahead and ${behind} behind ${counterpart}`;
  }
  if (ahead > 0) {
    return `${commitCount(ahead)} ahead of ${counterpart}`;
  }
  return `${commitCount(behind)} behind ${counterpart}`;
}

export function buildBranchPickerItems(details: readonly BranchPickerDetail[]): PickerItem[] {
  const items: PickerItem[] = [];

  for (const detail of details) {
    const hasKnownProvenance = detail.hasLocal !== undefined || detail.hasRemote !== undefined;
    if (!hasKnownProvenance) {
      items.push({
        kind: "branch",
        name: detail.name,
        refName: detail.name,
        accessibilityLabel: `${detail.name}, branch`,
        committerDate: detail.committerDate,
      });
      continue;
    }

    const hasLocal = detail.hasLocal === true;
    const hasRemote = detail.hasRemote === true;
    const localAhead = detail.localAhead;
    const localBehind = detail.localBehind;
    const hasDivergence =
      hasLocal && hasRemote && localAhead !== undefined && localBehind !== undefined;

    if (hasLocal) {
      const localItem: Extract<PickerItem, { kind: "branch" }> = {
        kind: "branch",
        name: detail.name,
        refName: `refs/heads/${detail.name}`,
        accessibilityLabel: `${detail.name}, local branch`,
        committerDate: detail.committerDate,
      };
      if (hasDivergence) {
        localItem.divergenceLabel = divergenceLabel(localAhead, localBehind);
        localItem.accessibilityLabel += `, ${divergenceAccessibility(
          localAhead,
          localBehind,
          `origin ${detail.name}`,
        )}`;
      }
      items.push(localItem);
    }

    const refsDiffer = hasDivergence && (localAhead > 0 || localBehind > 0);
    if (hasRemote && (!hasLocal || !hasDivergence || refsDiffer)) {
      const remoteAhead = hasDivergence ? localBehind : 0;
      const remoteBehind = hasDivergence ? localAhead : 0;
      const remoteItem: Extract<PickerItem, { kind: "branch" }> = {
        kind: "branch",
        name: `origin/${detail.name}`,
        refName: `refs/remotes/origin/${detail.name}`,
        accessibilityLabel: `origin ${detail.name}, origin branch`,
        committerDate: detail.committerDate,
      };
      if (hasDivergence) {
        remoteItem.divergenceLabel = divergenceLabel(remoteAhead, remoteBehind);
        remoteItem.accessibilityLabel = `origin ${detail.name}, ${divergenceAccessibility(
          remoteAhead,
          remoteBehind,
          `local ${detail.name}`,
        )}`;
      }
      items.push(remoteItem);
    }
  }

  return items;
}

export function pickerItemToCheckoutRequest(
  item: PickerItem | null,
): PickerCheckoutRequest | undefined {
  if (!item) return undefined;
  switch (item.kind) {
    case "branch":
      return { action: "branch-off", refName: item.refName };
    case "github-pr": {
      const headRefName = item.item.headRefName?.trim();
      const forge = item.item.forge ?? "github";
      return {
        action: "checkout",
        ...(headRefName ? { refName: headRefName } : {}),
        checkoutSource: {
          kind: "change_request",
          forge,
          number: item.item.number,
          ...(item.item.projectPath ? { projectPath: item.item.projectPath } : {}),
        },
        ...(forge === "github"
          ? {
              // COMPAT(githubPrNumber): added in v0.1.106, remove after 2026-12-28 once
              // daemon floor parses checkoutSource.
              githubPrNumber: item.item.number,
            }
          : {}),
      };
    }
  }
}

export function resolveCheckoutRequest(
  selectedItem: PickerItem | null,
  checkoutStatus: CheckoutStatusPayload,
): PickerCheckoutRequest | undefined {
  const selectedCheckoutRequest = pickerItemToCheckoutRequest(selectedItem);
  if (selectedCheckoutRequest) return selectedCheckoutRequest;
  if (!checkoutStatus.currentBranch) return undefined;
  return {
    action: "branch-off",
    refName: checkoutStatus.currentBranch,
  };
}
