import { open } from "node:fs/promises";
import { limitAgentTimelineItemContent } from "../../../agent-timeline-content.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage } from "../rpc-types.js";
import { extractTextFromToolResult, type PiToolResult } from "../tool-call-mapper.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;

export function outputFileFromToolResult(result: PiToolResult): string | undefined {
  return extractTextFromToolResult(result)?.match(/^Output file:\s*(\S+)$/m)?.[1];
}

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
    events.push(...mapChildLine(mapper, id, line).slice(0, MAX_ITEMS - events.length));
  }
  return events;
}

function mapChildLine(
  mapper: PiHistoryMapper,
  id: string,
  line: string,
): ProviderSubagentInputEvent[] {
  let entry: { message?: PiAgentMessage; timestamp?: string };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!entry.message || typeof entry.message !== "object" || !("role" in entry.message)) return [];
  return mapper.mapMessages([entry.message]).flatMap((mapped) =>
    mapped.type === "timeline"
      ? [
          {
            type: "timeline" as const,
            id,
            item: limitAgentTimelineItemContent(mapped.item),
            ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
          },
        ]
      : [],
  );
}

/** Incrementally reads one append-only child transcript. A partial JSONL row is held until newline. */
export class PiChildSessionFollower {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private readonly mapper = new PiHistoryMapper("pi");
  private items = 0;

  constructor(
    private readonly id: string,
    private readonly file: string,
  ) {}

  async readNew(): Promise<ProviderSubagentInputEvent[]> {
    if (this.offset >= MAX_BYTES || this.items >= MAX_ITEMS) return [];
    try {
      const handle = await open(this.file, "r");
      try {
        const size = Math.min((await handle.stat()).size - this.offset, MAX_BYTES - this.offset);
        if (size <= 0) return [];
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
        this.offset += bytesRead;
        const data = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        const lastNewline = data.lastIndexOf(10);
        if (lastNewline < 0) {
          this.pending = data;
          return [];
        }
        this.pending = data.subarray(lastNewline + 1);
        const events: ProviderSubagentInputEvent[] = [];
        for (const line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
          if (this.items >= MAX_ITEMS) break;
          const mapped = mapChildLine(this.mapper, this.id, line).slice(0, MAX_ITEMS - this.items);
          this.items += mapped.length;
          events.push(...mapped);
        }
        return events;
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }
}
