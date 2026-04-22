import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";

export type GeneratedReviewComposerAttachment = Extract<ComposerAttachment, { kind: "review" }>;

export function isGeneratedReviewAttachment(
  attachment: ComposerAttachment,
): attachment is GeneratedReviewComposerAttachment {
  return attachment.kind === "review" && attachment.generated === true;
}

export function stripGeneratedReviewAttachments(
  attachments: readonly ComposerAttachment[],
): UserComposerAttachment[] {
  return attachments.filter((attachment) => !isGeneratedReviewAttachment(attachment));
}
