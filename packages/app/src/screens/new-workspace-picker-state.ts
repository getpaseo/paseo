import {
  NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER,
  type UserComposerAttachment,
} from "@/attachments/types";
import type { PickerItem } from "./new-workspace-picker-item";

function isPickerOwnedPrAttachment(attachment: UserComposerAttachment): attachment is Extract<
  UserComposerAttachment,
  { kind: "github_pr" }
> & {
  owner: typeof NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER;
} {
  return (
    attachment.kind === "github_pr" && attachment.owner === NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER
  );
}

// Ownership lives on the attachment because drafts outlive this component.
// The picker owns at most one PR; user-added PRs and issues remain untouched.
export function syncPickerPrAttachment(input: {
  attachments: UserComposerAttachment[];
  item: PickerItem | null;
}): UserComposerAttachment[] {
  const nextAttachments = input.attachments.filter(
    (attachment) => !isPickerOwnedPrAttachment(attachment),
  );

  if (input.item?.kind === "github-pr") {
    const selectedPr = input.item.item;
    const hasExistingPrAttachment = nextAttachments.some(
      (attachment) =>
        attachment.kind === "github_pr" && attachment.item.number === selectedPr.number,
    );
    if (!hasExistingPrAttachment) {
      return [
        ...nextAttachments,
        {
          kind: "github_pr",
          item: selectedPr,
          owner: NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER,
        },
      ];
    }
  }

  return nextAttachments;
}

export function clearPickerPrAttachmentForTargetChange(input: {
  attachments: UserComposerAttachment[];
  currentTargetId: string;
  nextTargetId: string;
}): UserComposerAttachment[] {
  if (input.currentTargetId === input.nextTargetId) {
    return input.attachments;
  }
  return syncPickerPrAttachment({ attachments: input.attachments, item: null });
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
