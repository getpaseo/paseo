import { open } from "node:fs/promises";
import { limitAgentTimelineItemContent } from "../../../agent-timeline-content.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage } from "../rpc-types.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;

/** Child session files are immutable once the completed result exposes their path. */
export async function mapPiChildSession(
  id: string,
  file: string,
  maxBytes = MAX_BYTES,
): Promise<ProviderSubagentInputEvent[]> {
  try {
    const handle = await open(file, "r");
    try {
      const fileSize = (await handle.stat()).size;
      const size = Math.min(fileSize, MAX_BYTES, maxBytes);
      if (!size) return [];
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      const text = buffer.toString("utf8", 0, bytesRead);
      const completeText = bytesRead < fileSize ? text.slice(0, text.lastIndexOf("\n")) : text;
      return parseChildTimeline(id, completeText);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function parseChildTimeline(id: string, text: string): ProviderSubagentInputEvent[] {
  const mapper = new PiHistoryMapper("pi");
  const events: ProviderSubagentInputEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line || events.length >= MAX_ITEMS) break;
    let entry: { message?: PiAgentMessage; timestamp?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.message || typeof entry.message !== "object" || !("role" in entry.message)) continue;
    for (const mapped of mapper.mapMessages([entry.message])) {
      if (mapped.type !== "timeline") continue;
      events.push({
        type: "timeline",
        id,
        item: limitAgentTimelineItemContent(mapped.item),
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      });
      if (events.length >= MAX_ITEMS) break;
    }
  }
  return events;
}
