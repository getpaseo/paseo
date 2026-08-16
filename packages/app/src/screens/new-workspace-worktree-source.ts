import { slugify } from "@getpaseo/protocol/branch-slug";
import type { PickerItem } from "./new-workspace-picker-item";

export type WorktreeSourceMode = "new-branch" | "existing-branch";

export interface WorktreeCheckoutRequest {
  action: "branch-off" | "checkout";
  refName: string;
  worktreeSlug?: string;
}

export function worktreeSlugForPickerItem(item: PickerItem): string {
  if (item.kind !== "branch") {
    throw new Error("Choose a branch");
  }

  const refName = item.refName
    .replace(/^refs\/heads\//u, "")
    .replace(/^refs\/remotes\/[^/]+\//u, "");
  const slug = slugify(refName);
  if (!slug) {
    throw new Error("Choose a branch");
  }
  return slug;
}

export function buildWorktreeCheckoutRequest(input: {
  mode: WorktreeSourceMode;
  item: PickerItem | null;
}): WorktreeCheckoutRequest {
  const item = input.item;
  if (!item || item.kind !== "branch") {
    throw new Error("Choose a branch");
  }

  return input.mode === "existing-branch"
    ? {
        action: "checkout",
        refName: item.refName,
        worktreeSlug: worktreeSlugForPickerItem(item),
      }
    : {
        action: "branch-off",
        refName: item.refName,
      };
}
