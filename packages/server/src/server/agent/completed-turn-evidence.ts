import { createHash } from "node:crypto";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { AgentStreamEvent, AgentTimelineItem } from "./agent-sdk-types.js";
import { projectTimelineRows } from "./timeline-projection.js";
import { PLUGIN_TIMELINE_DATA_MAX_BYTES } from "./agent-timeline-content.js";

interface PromptEvidence {
  digest: string;
  clientMessageId?: string;
  messageId?: string;
  providerMessageId?: string;
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

function promptEvidence({ item, providerMessageId }: AgentTimelineRow): PromptEvidence | undefined {
  return item.type === "user_message"
    ? {
        digest: digest(item.text),
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
      }
    : undefined;
}

function matchesPrompt(item: AgentTimelineItem, prompt: PromptEvidence): boolean {
  return (
    item.type === "user_message" &&
    digest(item.text) === prompt.digest &&
    Boolean(prompt.providerMessageId) &&
    item.messageId === prompt.providerMessageId
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
  if (!rows[start]!.providerMessageId || (origin && !origin.providerMessageId)) return undefined;
  const evidence: CompletedTurnEvidence = {
    turnId,
    prompt: promptEvidence(rows[start]!)!,
    signature: signature(selected),
    ...(origin ? { origin: promptEvidence(origin) } : {}),
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
  if (
    !evidence?.prompt.providerMessageId ||
    (evidence.origin && !evidence.origin.providerMessageId)
  )
    return history;
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
  const origins =
    evidence.origin && rows.filter((row) => matchesPrompt(row.item, evidence.origin!));
  const source = origins?.length === 1 ? origins[0] : undefined;
  if (evidence.origin && !source) return history;
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
