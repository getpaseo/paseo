import { extractInteractiveDocumentId } from "@getpaseo/protocol/interactive-response-reference";
import type { AgentTimelineRow } from "./agent/agent-timeline-store-types.js";
import { isInteractiveResponseToolName } from "@getpaseo/protocol/tool-name-normalization";

export function selectResponseContext(
  rows: readonly AgentTimelineRow[],
  reference: { messageId?: string; cursor?: { seq: number } },
): { text: string; documentIds: string[] } {
  const index = rows.findIndex((row) =>
    reference.messageId
      ? row.item.type === "assistant_message" && row.item.messageId === reference.messageId
      : row.seq === reference.cursor?.seq,
  );
  if (index < 0 || rows[index]!.item.type !== "assistant_message")
    throw new Error("The original response is no longer available");
  let start = index;
  let end = index + 1;
  while (start > 0 && rows[start - 1]!.item.type !== "user_message") start--;
  while (end < rows.length && rows[end]!.item.type !== "user_message") end++;
  const text: string[] = [];
  const ids = new Set<string>();
  for (const row of rows.slice(start, end)) {
    const item = row.item;
    if (item.type === "assistant_message") text.push(item.text);
    if (
      item.type === "tool_call" &&
      isInteractiveResponseToolName(item.name) &&
      item.detail.type === "unknown"
    ) {
      const id = extractInteractiveDocumentId(item.detail.output);
      if (id) ids.add(id);
    }
  }
  return { text: text.join("\n\n"), documentIds: [...ids] };
}
