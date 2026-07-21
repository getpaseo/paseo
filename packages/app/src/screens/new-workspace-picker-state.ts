import {
  NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER,
  type UserComposerAttachment,
} from "@/attachments/types";
import type { PickerItem } from "./new-workspace-picker-item";

function isPrAttachment(
  attachment: UserComposerAttachment,
): attachment is Extract<UserComposerAttachment, { kind: "forge_change_request" | "github_pr" }> {
  return attachment.kind === "forge_change_request" || attachment.kind === "github_pr";
}

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
      (attachment) => isPrAttachment(attachment) && attachment.item.number === selectedPr.number,
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
  return input.attachments.filter((attachment) => !isPrAttachment(attachment));
}

export function pickerItemFromAttachments(
  attachments: ReadonlyArray<UserComposerAttachment>,
): PickerItem | null {
  for (const attachment of attachments) {
    if (!isPrAttachment(attachment)) continue;
    return { kind: "github-pr", item: attachment.item };
  }

  return null;
}
