import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";

export function stripGeneratedReviewAttachments(
  attachments: readonly ComposerAttachment[],
): UserComposerAttachment[] {
  return attachments.filter(
    (attachment): attachment is UserComposerAttachment => attachment.kind !== "review",
  );
}
