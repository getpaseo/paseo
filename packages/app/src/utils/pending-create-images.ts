import type { StreamItem, UserMessageImageAttachment } from "@/types/stream";

type MergePendingCreateImagesParams = {
  streamItems: StreamItem[];
  clientMessageId: string;
  images?: UserMessageImageAttachment[];
};

export function mergePendingCreateImages({
  streamItems,
  clientMessageId,
  images,
}: MergePendingCreateImagesParams): StreamItem[] {
  if (!images || images.length === 0) {
    return streamItems;
  }

  const targetIndex = streamItems.findIndex(
    (item) => item.kind === "user_message" && item.id === clientMessageId
  );
  if (targetIndex < 0) {
    return streamItems;
  }

  const target = streamItems[targetIndex];
  if (target.kind !== "user_message") {
    return streamItems;
  }
  if (target.images && target.images.length > 0) {
    return streamItems;
  }

  const next = [...streamItems];
  next[targetIndex] = { ...target, images };
  return next;
}
