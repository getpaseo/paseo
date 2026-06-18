import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { GitHubSearchItem } from "@getpaseo/protocol/messages";

export type PickerItem =
  | { kind: "branch"; name: string }
  | {
      kind: "github-pr";
      item: GitHubSearchItem;
    };

export type PickerCheckoutRequest = Pick<
  CreatePaseoWorktreeInput,
  "action" | "refName" | "githubPrNumber"
>;

export function pickerItemToCheckoutRequest(
  item: PickerItem | null,
): PickerCheckoutRequest | undefined {
  if (!item) return undefined;
  switch (item.kind) {
    case "branch":
      return { action: "branch-off", refName: item.name };
    case "github-pr": {
      const headRefName = item.item.headRefName?.trim();
      return {
        action: "checkout",
        ...(headRefName ? { refName: headRefName } : {}),
        githubPrNumber: item.item.number,
      };
    }
  }
}
