import { createHash } from "node:crypto";
import { z } from "zod";
import { projectTimelineRows } from "./timeline-projection.js";
import type { AgentProvider, AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";

const anchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("message"), hash: z.string() }),
  z.object({ kind: z.literal("tool"), callId: z.string() }),
  z.object({ kind: z.literal("unresolved") }),
]);

export const modelSwitchRecordSchema = z.object({
  model: z.string().nullable(),
  timestamp: z.string(),
  anchor: anchorSchema,
});
export type ModelSwitchRecord = z.infer<typeof modelSwitchRecordSchema>;
type TimelineEvent = Extract<AgentStreamEvent, { type: "timeline" }>;

function anchorForItem(item: AgentTimelineItem): ModelSwitchRecord["anchor"] {
  if (item.type === "user_message" || item.type === "assistant_message") {
    const hash = createHash("sha256")
      .update(item.type)
      .update("\0")
      .update(item.text)
      .digest("hex");
    return { kind: "message", hash };
  }
  if (item.type === "tool_call" && item.status !== "running") {
    return { kind: "tool", callId: item.callId };
  }
  return { kind: "unresolved" };
}

export function captureModelSwitchAnchor(
  items: readonly AgentTimelineItem[],
): ModelSwitchRecord["anchor"] {
  const last = items.findLast((item) => item.type !== "notification" || !item.modelChange);
  return last ? anchorForItem(last) : { kind: "start" };
}

export function modelSwitchItem(model: string | null): AgentTimelineItem {
  return {
    type: "notification",
    level: "info",
    message: model ? `Switched to ${model}` : "Switched to the default model",
    modelChange: { model },
  };
}

export function restoreModelSwitches(
  history: readonly TimelineEvent[],
  records: readonly ModelSwitchRecord[],
  provider: AgentProvider,
): TimelineEvent[] {
  const projected = projectTimelineRows({
    mode: "projected",
    rows: history.map((entry, index) => ({
      seq: index + 1,
      timestamp: entry.timestamp ?? "",
      item: entry.item,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
    })),
  });
  const anchors = projected.map((entry) => anchorForItem(entry.item));
  const insertions = new Map<number, TimelineEvent[]>();
  for (const record of records) {
    let index = -1;
    if (record.anchor.kind !== "start") {
      if (record.anchor.kind === "unresolved") continue;
      const matches = anchors.flatMap((anchor, i) =>
        JSON.stringify(anchor) === JSON.stringify(record.anchor) ? [i] : [],
      );
      if (matches.length !== 1) continue;
      index = projected[matches[0]!]!.seqEnd - 1;
    }
    const event: TimelineEvent = {
      type: "timeline",
      provider,
      item: modelSwitchItem(record.model),
      timestamp: record.timestamp,
    };
    const group = insertions.get(index) ?? [];
    group.push(event);
    insertions.set(index, group);
  }
  const result = [...(insertions.get(-1) ?? [])];
  history.forEach((event, index) => result.push(event, ...(insertions.get(index) ?? [])));
  return result;
}
