import { open } from "node:fs/promises";
import { limitAgentTimelineItemContent } from "../../../agent-timeline-content.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { PiHistoryMapper } from "../history-mapper.js";
import type { PiAgentMessage } from "../rpc-types.js";

export const CHILD_SESSION_MAX_BYTES_PER_READ = 2 * 1024 * 1024;
const MAX_ITEMS_PER_READ = 200;
/**
 * A single JSONL entry this large cannot be parsed without buffering that much again. Pi entries are
 * orders of magnitude smaller, so crossing it means the file is not a session transcript.
 */
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface ChildSessionTailRead {
  events: ProviderSubagentInputEvent[];
  /** Bytes consumed since the previous read. Drives the poll backoff. */
  bytes: number;
  /** The file shrank or is unparseable. Stop following it: rewinding would duplicate every row. */
  fatal: boolean;
}

/**
 * Incremental reader for one Pi child session file.
 *
 * Child session files are append-only JSONL, so a reader only needs the bytes past what it has
 * already parsed. The offset and the unterminated tail of the last line survive between reads,
 * which is what makes reading a file that is still being written safe: a chunk that ends mid-line is
 * completed by the next chunk instead of being dropped or reparsed.
 *
 * One mapper instance spans every read, because a tool result in a later chunk still has to resolve
 * the tool call that opened it in an earlier one.
 */
export class ChildSessionTail {
  private readonly mapper = new PiHistoryMapper("pi");
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);

  constructor(
    private readonly id: string,
    private readonly file: string,
  ) {}

  async read(maxBytes = CHILD_SESSION_MAX_BYTES_PER_READ): Promise<ChildSessionTailRead> {
    const empty: ChildSessionTailRead = { events: [], bytes: 0, fatal: false };
    if (maxBytes <= 0) return empty;
    let handle;
    try {
      handle = await open(this.file, "r");
    } catch {
      // The path is often published a beat before the plugin creates the file.
      return empty;
    }
    try {
      const size = (await handle.stat()).size;
      if (size < this.offset) return { events: [], bytes: 0, fatal: true };
      const length = Math.min(size - this.offset, maxBytes);
      if (length <= 0) return empty;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      if (bytesRead <= 0) return empty;
      this.offset += bytesRead;
      return this.consume(buffer.subarray(0, bytesRead));
    } catch {
      return empty;
    } finally {
      await handle.close();
    }
  }

  /** Reads to the end of the file, bounded by `maxBytes` and `maxItems`. */
  async readAll(
    maxBytes = CHILD_SESSION_MAX_BYTES_PER_READ,
    maxItems = MAX_ITEMS_PER_READ,
  ): Promise<ProviderSubagentInputEvent[]> {
    const events: ProviderSubagentInputEvent[] = [];
    let budget = maxBytes;
    for (;;) {
      const read = await this.read(budget);
      if (read.fatal) break;
      events.push(...read.events);
      budget -= read.bytes;
      if (read.bytes <= 0 || budget <= 0 || events.length >= maxItems) break;
    }
    return events.slice(0, maxItems);
  }

  private consume(chunk: Buffer): ChildSessionTailRead {
    const combined = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const lastNewline = combined.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      if (combined.length > MAX_LINE_BYTES) return { events: [], bytes: chunk.length, fatal: true };
      this.remainder = Buffer.from(combined);
      return { events: [], bytes: chunk.length, fatal: false };
    }
    const complete = combined.subarray(0, lastNewline).toString("utf8");
    this.remainder = Buffer.from(combined.subarray(lastNewline + 1));
    return {
      events: parseChildTimeline(this.mapper, this.id, complete),
      bytes: chunk.length,
      fatal: false,
    };
  }
}

function parseChildTimeline(
  mapper: PiHistoryMapper,
  id: string,
  text: string,
): ProviderSubagentInputEvent[] {
  const events: ProviderSubagentInputEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line || events.length >= MAX_ITEMS_PER_READ) break;
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
      if (events.length >= MAX_ITEMS_PER_READ) break;
    }
  }
  return events;
}
