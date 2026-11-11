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

/** Reads a finished child transcript once, up to `maxBytes`. */
export function mapPiChildSession(
  id: string,
  file: string,
  maxBytes = MAX_BYTES,
): Promise<ProviderSubagentInputEvent[]> {
  return new PiChildSessionFollower(id, file, maxBytes).readNew();
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
  private readonly maxBytes: number;

  constructor(
    private readonly id: string,
    private readonly file: string,
    maxBytes = MAX_BYTES,
  ) {
    this.maxBytes = Math.min(maxBytes, MAX_BYTES);
  }

  async readNew(): Promise<ProviderSubagentInputEvent[]> {
    if (this.offset >= this.maxBytes || this.items >= MAX_ITEMS) return [];
    try {
      const handle = await open(this.file, "r");
      try {
        const size = Math.min((await handle.stat()).size, this.maxBytes) - this.offset;
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
