import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { AgentAttachment } from "@server/shared/messages";
import { buildGitHubAttachmentFromSearchItem } from "@/utils/review-attachments";

export type ImageAttachment = AttachmentMetadata;

function isComposerAttachment(value: unknown): value is ComposerAttachment {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "image" || kind === "github_search_item";
}

export function splitComposerAttachmentsForSubmit(
  // Accepts unknown[] for callers that flow attachments through MessagePayload
  // (which currently types attachments as unknown[] for back-compat). Items
  // that don't match the ComposerAttachment shape are silently dropped.
  attachments: ComposerAttachment[] | readonly unknown[] | undefined,
): {
  images: ImageAttachment[];
  attachments: AgentAttachment[];
} {
  const images: ImageAttachment[] = [];
  const reviewAttachments: AgentAttachment[] = [];

  if (!attachments) {
    return { images, attachments: reviewAttachments };
  }

  for (const raw of attachments) {
    if (!isComposerAttachment(raw)) continue;
    const attachment = raw;
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
