import type { CreatePaseoWorktreeInput } from "@server/client/daemon-client";
import type { GitHubSearchItem } from "@server/shared/messages";

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
    case "github-pr":
      return {
        action: "checkout",
        refName: item.item.headRefName ?? "",
        githubPrNumber: item.item.number,
      };
  }
}
