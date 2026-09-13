import { createHash } from "node:crypto";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import { projectTimelineRows } from "./timeline-projection.js";
import { PLUGIN_TIMELINE_DATA_MAX_BYTES } from "./agent-timeline-content.js";

interface PromptEvidence {
  digest: string;
  clientMessageId?: string;
  messageId?: string;
}
export interface CompletedTurnEvidence {
  turnId: string;
  prompt: PromptEvidence;
  signature: string;
  origin?: PromptEvidence;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate) =>
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)))
          : candidate,
      ),
    )
    .digest("hex");
}

function promptEvidence(item: AgentTimelineItem): PromptEvidence | undefined {
  return item.type === "user_message"
    ? {
        digest: digest(item.text),
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        ...(item.messageId && item.messageId !== item.clientMessageId
          ? { messageId: item.messageId }
          : {}),
      }
    : undefined;
}

function matchesPrompt(item: AgentTimelineItem, prompt: PromptEvidence): boolean {
  return (
    item.type === "user_message" &&
    digest(item.text) === prompt.digest &&
    (!prompt.messageId || item.messageId === prompt.messageId)
  );
}

function signature(rows: readonly AgentTimelineRow[]): string {
  const items = projectTimelineRows({ rows, mode: "projected" }).flatMap(({ item }) => {
    if (item.type === "user_message" || item.type === "assistant_message")
      return [[item.type, item.text]];
    if (item.type === "tool_call")
      return [
        [
          item.type,
          item.callId,
          item.status,
          item.detail,
          item.error ?? null,
          item.metadata?.approved ?? null,
        ],
      ];
    return [];
  });
  return digest(items);
}

export function captureCompletedTurnEvidence(
  rows: readonly AgentTimelineRow[],
  turnId?: string,
): CompletedTurnEvidence | undefined {
  if (!turnId) return undefined;
  const end = rows.findLastIndex((row) => row.turnId === turnId);
  const start = rows.findLastIndex(
    (row, index) => index <= end && row.item.type === "user_message",
  );
  if (start < 0 || end <= start) return undefined;
  const selected = rows.slice(start, end + 1);
  if (selected.some((row) => row.turnId && row.turnId !== turnId)) return undefined;
  const origin = rows.find((row) => row.item.type === "user_message" && row.item.clientMessageId);
  const evidence: CompletedTurnEvidence = {
    turnId,
    prompt: promptEvidence(rows[start]!.item)!,
    signature: signature(selected),
    ...(origin ? { origin: promptEvidence(origin.item) } : {}),
  };
  // Only two prompt correlations and one digest, never a saved conversation. Refuse
  // oversized IDs rather than truncating the causal witness.
  return Buffer.byteLength(JSON.stringify(evidence)) <= PLUGIN_TIMELINE_DATA_MAX_BYTES
    ? evidence
    : undefined;
}

export function restoreCompletedTurnEvidence(
  history: AgentStreamEvent[],
  evidence?: CompletedTurnEvidence,
): AgentStreamEvent[] {
  if (!evidence) return history;
  const rows = history.flatMap((event, seq): AgentTimelineRow[] =>
    event.type === "timeline"
      ? [{ seq, timestamp: event.timestamp ?? "", turnId: event.turnId, item: event.item }]
      : [],
  );
  const start = rows.findLastIndex((row) => row.item.type === "user_message");
  if (
    start < 0 ||
    !matchesPrompt(rows[start]!.item, evidence.prompt) ||
    rows.filter((row) => matchesPrompt(row.item, evidence.prompt)).length !== 1
  )
    return history;
  const selected = rows.slice(start);
  if (
    selected.some((row) => row.turnId && row.turnId !== evidence.turnId) ||
    signature(selected) !== evidence.signature
  )
    return history;
  const source = evidence.origin && rows.find((row) => matchesPrompt(row.item, evidence.origin!));
  return history.map((event, index) => {
    if (event.type !== "timeline") return event;
    let prompt = index === source?.seq ? evidence.origin : undefined;
    if (index === rows[start]!.seq) prompt = evidence.prompt;
    return {
      ...event,
      ...(index >= rows[start]!.seq ? { turnId: evidence.turnId } : {}),
      ...(event.item.type === "user_message" && prompt?.clientMessageId
        ? { item: { ...event.item, clientMessageId: prompt.clientMessageId } }
        : {}),
    };
  });
}
