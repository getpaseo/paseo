import type { StreamItem, UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@server/shared/messages";

interface MergePendingCreateImagesParams {
  streamItems: StreamItem[];
  clientMessageId: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export function mergePendingCreateImages({
  streamItems,
  clientMessageId,
  images,
  attachments,
}: MergePendingCreateImagesParams): StreamItem[] {
  const hasPendingImages = Boolean(images && images.length > 0);
  const hasPendingAttachments = Boolean(attachments && attachments.length > 0);
  if (!hasPendingImages && !hasPendingAttachments) {
    return streamItems;
  }

  const targetIndex = streamItems.findIndex(
    (item) => item.kind === "user_message" && item.id === clientMessageId,
  );
  if (targetIndex < 0) {
    return streamItems;
  }

  const target = streamItems[targetIndex];
  if (target.kind !== "user_message") {
    return streamItems;
  }
  const shouldMergeImages = hasPendingImages && (!target.images || target.images.length === 0);
  const shouldMergeAttachments =
    hasPendingAttachments && (!target.attachments || target.attachments.length === 0);
  if (!shouldMergeImages && !shouldMergeAttachments) {
    return streamItems;
  }

  const next = [...streamItems];
  next[targetIndex] = {
    ...target,
    ...(shouldMergeImages ? { images } : {}),
    ...(shouldMergeAttachments ? { attachments } : {}),
  };
  return next;
}
