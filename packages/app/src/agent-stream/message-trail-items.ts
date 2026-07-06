import type { StreamItem } from "@/types/stream";

const PREVIEW_MAX_LENGTH = 280;

export interface MessageTrailItem {
  id: string;
  ordinal: number;
  preview: string;
  responsePreview: string;
  attachmentCount: number;
}

function normalizePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX_LENGTH ? collapsed.slice(0, PREVIEW_MAX_LENGTH) : collapsed;
}

function countAttachments(item: Extract<StreamItem, { kind: "user_message" }>): number {
  return (item.images?.length ?? 0) + (item.attachments?.length ?? 0);
}

export function deriveMessageTrailItems(
  tail: readonly StreamItem[],
  head: readonly StreamItem[],
): MessageTrailItem[] {
  const items: MessageTrailItem[] = [];
  let ordinal = 0;
  let current: MessageTrailItem | null = null;

  for (const item of [...tail, ...head]) {
    if (item.kind === "user_message") {
      ordinal += 1;
      current = {
        id: item.id,
        ordinal,
        preview: normalizePreview(item.text),
        responsePreview: "",
        attachmentCount: countAttachments(item),
      };
      items.push(current);
      continue;
    }

    if (item.kind === "assistant_message" && current && current.responsePreview === "") {
      current.responsePreview = normalizePreview(item.text);
    }
  }

  return items;
}
