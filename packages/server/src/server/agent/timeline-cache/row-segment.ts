import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";

import { readJsonFileCapped } from "./safe-json-file.js";

export interface AssistantRunAddress {
  startSeq: number;
  endSeq: number;
}

export interface TimelineSummary {
  minSeq: number;
  maxSeq: number;
  firstItemType: string;
  lastItemType: string;
  trailingAssistantStartSeq: number | null;
  lastAssistantRun: AssistantRunAddress | null;
}

export interface RowSegment {
  version: 1;
  rows: AgentTimelineRow[];
  summary: TimelineSummary;
}

export interface SegmentDescriptor {
  file: string;
  generation: number;
  minSeq: number;
  maxSeq: number;
  summary: TimelineSummary;
}

const TimelineSummarySchema = z.object({
  minSeq: z.number().int().positive(),
  maxSeq: z.number().int().positive(),
  firstItemType: z.string(),
  lastItemType: z.string(),
  trailingAssistantStartSeq: z.number().int().positive().nullable(),
  lastAssistantRun: z
    .object({ startSeq: z.number().int().positive(), endSeq: z.number().int().positive() })
    .nullable(),
});
const RowSegmentSchema: z.ZodType<RowSegment> = z.object({
  version: z.literal(1),
  rows: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        timestamp: z.string(),
        item: AgentTimelineItemPayloadSchema,
        turnId: z.string().optional(),
        providerMessageId: z.string().optional(),
      }),
    )
    .min(1),
  summary: TimelineSummarySchema,
});

export function buildRowSegment(rows: readonly AgentTimelineRow[]): RowSegment {
  if (rows.length === 0) throw new Error("Timeline segment must contain at least one row");
  let previousSeq = 0;
  let currentAssistantStart: number | null = null;
  let lastAssistantRun: AssistantRunAddress | null = null;
  for (const row of rows) {
    if (row.seq <= previousSeq) {
      throw new Error("Timeline rows must have strictly increasing sequence numbers");
    }
    previousSeq = row.seq;
    if (row.item.type === "assistant_message") {
      currentAssistantStart ??= row.seq;
      lastAssistantRun = { startSeq: currentAssistantStart, endSeq: row.seq };
    } else {
      currentAssistantStart = null;
    }
  }
  return {
    version: 1,
    rows: rows.map((row) => ({ ...row, item: structuredClone(row.item) })),
    summary: {
      minSeq: rows[0]!.seq,
      maxSeq: rows.at(-1)!.seq,
      firstItemType: rows[0]!.item.type,
      lastItemType: rows.at(-1)!.item.type,
      trailingAssistantStartSeq: currentAssistantStart,
      lastAssistantRun,
    },
  };
}

export function combineTimelineSummaries(
  left: TimelineSummary,
  right: TimelineSummary,
): TimelineSummary {
  if (left.maxSeq >= right.minSeq) throw new Error("Timeline summary ranges must not overlap");
  let lastAssistantRun = right.lastAssistantRun ?? left.lastAssistantRun;
  if (
    right.lastAssistantRun?.startSeq === right.minSeq &&
    right.firstItemType === "assistant_message" &&
    left.trailingAssistantStartSeq !== null
  ) {
    lastAssistantRun = {
      startSeq: left.trailingAssistantStartSeq,
      endSeq: right.lastAssistantRun.endSeq,
    };
  }
  let trailingAssistantStartSeq = right.trailingAssistantStartSeq;
  if (trailingAssistantStartSeq === right.minSeq && left.trailingAssistantStartSeq !== null) {
    trailingAssistantStartSeq = left.trailingAssistantStartSeq;
  }
  return {
    minSeq: left.minSeq,
    maxSeq: right.maxSeq,
    firstItemType: left.firstItemType,
    lastItemType: right.lastItemType,
    trailingAssistantStartSeq,
    lastAssistantRun,
  };
}

export function encodeRowSegment(segment: RowSegment, maxBytes: number): string {
  const parsed = validateRowSegment(segment);
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error(`Timeline segment exceeds the ${maxBytes}-byte limit`);
  }
  return text;
}

export async function readRowSegment(filePath: string, maxBytes: number): Promise<RowSegment> {
  return validateRowSegment(await readJsonFileCapped(filePath, maxBytes));
}

function validateRowSegment(value: unknown): RowSegment {
  const segment = RowSegmentSchema.parse(value);
  const rebuilt = buildRowSegment(segment.rows);
  if (JSON.stringify(rebuilt.summary) !== JSON.stringify(segment.summary)) {
    throw new Error("Timeline segment summary does not match its rows");
  }
  return segment;
}
