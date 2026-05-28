import type { UserComposerAttachment } from "@/attachments/types";
import type { PickerItem } from "./new-workspace-picker-item";

// The picker "owns" at most one PR attachment at a time. When the user selects
// a different item the previously-owned PR is removed before the new one is added.
// User-added attachments for other PRs/issues are left untouched.
export function syncPickerPrAttachment(input: {
  attachments: UserComposerAttachment[];
  previousPickerPrNumber: number | null;
  item: PickerItem;
}): { attachments: UserComposerAttachment[]; attachedPrNumber: number | null } {
  let nextAttachments = input.attachments;
  let attachedPrNumber: number | null = null;

  if (input.previousPickerPrNumber !== null) {
    nextAttachments = nextAttachments.filter(
      (attachment) =>
        attachment.kind !== "github_pr" || attachment.item.number !== input.previousPickerPrNumber,
    );
  }

  if (input.item.kind === "github-pr") {
    const selectedPr = input.item.item;
    const hasExistingPrAttachment = nextAttachments.some(
      (attachment) =>
        attachment.kind === "github_pr" && attachment.item.number === selectedPr.number,
    );
    if (!hasExistingPrAttachment) {
      nextAttachments = [...nextAttachments, { kind: "github_pr", item: selectedPr }];
      attachedPrNumber = selectedPr.number;
    }
  }

  return { attachments: nextAttachments, attachedPrNumber };
}

export function findCheckoutHintPrAttachment(input: {
  attachments: ReadonlyArray<UserComposerAttachment>;
  selectedItem: PickerItem | null;
  dismissedPrNumbers: ReadonlySet<number>;
}): Extract<UserComposerAttachment, { kind: "github_pr" }> | null {
  const selectedPrNumber =
    input.selectedItem?.kind === "github-pr" ? input.selectedItem.item.number : null;

  for (const attachment of input.attachments) {
    if (attachment.kind !== "github_pr") continue;
    const prNumber = attachment.item.number;
    if (prNumber === selectedPrNumber) continue;
    if (input.dismissedPrNumbers.has(prNumber)) continue;
    return attachment;
  }

  return null;
}
