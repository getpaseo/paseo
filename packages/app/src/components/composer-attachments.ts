import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import {
  isWorkspaceAttachment,
  workspaceAttachmentToSubmitAttachment,
} from "@/attachments/workspace-attachment-utils";
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

    if (isWorkspaceAttachment(attachment)) {
      const workspaceAttachment = workspaceAttachmentToSubmitAttachment(attachment);
      if (workspaceAttachment) {
        reviewAttachments.push(workspaceAttachment);
      }
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
