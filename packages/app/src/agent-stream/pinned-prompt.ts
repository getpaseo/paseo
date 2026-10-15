import type { StreamItem, UserMessageItem } from "@/types/stream";

export function resolvePinnedPrompt(
  items: readonly StreamItem[],
  readingRowId: string | null,
): UserMessageItem | null {
  if (!readingRowId) return null;
  let prompt: UserMessageItem | null = null;
  for (const item of items) {
    if (item.id === readingRowId) return item.kind === "user_message" ? null : prompt;
    if (item.kind === "user_message") prompt = item;
  }
  return null;
}
