import type { BackgroundRequest, BackgroundRow } from "@getpaseo/protocol/messages";
import { reduceStreamUpdate, type StreamItem } from "@/types/stream";

export function projectBackgroundRows(rows: BackgroundRow[], epoch: string) {
  let items: StreamItem[] = [];
  const prompts = new Map<string, string>();
  for (const row of rows) {
    items = reduceStreamUpdate(items, row.event, new Date(row.timestamp), {
      timelineCursor: { epoch, seq: row.seq },
    });
    if (row.event.type === "timeline" && row.event.item.type === "user_message") {
      const prompt = items.findLast((item) => item.kind === "user_message");
      if (prompt && !prompts.has(row.requestId)) prompts.set(row.requestId, prompt.id);
    }
  }
  return { items, prompts };
}

export function sortBackgroundRequests(requests: BackgroundRequest[]): BackgroundRequest[] {
  const active = (request: BackgroundRequest) =>
    request.status === "running" || request.status === "queued";
  return [...requests].sort(
    (left, right) =>
      Number(active(right)) - Number(active(left)) || right.createdAt - left.createdAt,
  );
}
