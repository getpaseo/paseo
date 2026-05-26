import type { StreamItem, UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

interface MergePendingCreateImagesParams {
  streamItems: StreamItem[];
  clientMessageId: string;
  text?: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export function findPendingCreateUserMessageIndex({
  streamItems,
  clientMessageId,
  text,
}: Pick<MergePendingCreateImagesParams, "streamItems" | "clientMessageId" | "text">): number {
  const clientMessageIndex = streamItems.findIndex(
    (item) => item.kind === "user_message" && item.id === clientMessageId,
  );
  if (clientMessageIndex >= 0 || text === undefined) {
    return clientMessageIndex;
  }

  const firstUserMessageIndex = streamItems.findIndex((item) => item.kind === "user_message");
  if (firstUserMessageIndex < 0) {
    return -1;
  }

  const firstUserMessage = streamItems[firstUserMessageIndex];
  return firstUserMessage.kind === "user_message" && firstUserMessage.text === text
    ? firstUserMessageIndex
    : -1;
}

export function mergePendingCreateImages({
  streamItems,
  clientMessageId,
  text,
  images,
  attachments,
}: MergePendingCreateImagesParams): StreamItem[] {
  const hasPendingImages = Boolean(images && images.length > 0);
  const hasPendingAttachments = Boolean(attachments && attachments.length > 0);
  if (!hasPendingImages && !hasPendingAttachments) {
    return streamItems;
  }

  const targetIndex = findPendingCreateUserMessageIndex({ streamItems, clientMessageId, text });
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
