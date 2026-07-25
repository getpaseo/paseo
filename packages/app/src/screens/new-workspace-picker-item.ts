import type { CreatePaseoWorktreeInput } from "@getpaseo/client/internal/daemon-client";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";

export type PickerItem =
  | { kind: "branch"; name: string }
  | {
      kind: "github-pr";
      item: ForgeSearchItem;
    };

export type PickerCheckoutRequest = Pick<
  CreatePaseoWorktreeInput,
  "action" | "refName" | "checkoutSource" | "githubPrNumber"
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
