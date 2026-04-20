import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { AgentAttachment } from "@server/shared/messages";
import { buildGitHubAttachmentFromSearchItem } from "@/utils/review-attachments";

export type ImageAttachment = AttachmentMetadata;

export function splitComposerAttachmentsForSubmit(attachments: ComposerAttachment[]): {
  images: ImageAttachment[];
  attachments: AgentAttachment[];
} {
  const images: ImageAttachment[] = [];
  const reviewAttachments: AgentAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      images.push(attachment.metadata);
      continue;
    }

    const reviewAttachment = buildGitHubAttachmentFromSearchItem(attachment.item);
    if (reviewAttachment) {
      reviewAttachments.push(reviewAttachment);
    }
  }

  return {
    images,
    attachments: reviewAttachments,
  };
}
