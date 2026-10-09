import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";

export const ASSISTANT_MESSAGE_DEFAULT_LIMIT = 10;
export const ASSISTANT_MESSAGE_MAX_LIMIT = 50;
const MAX_TEXT_LENGTH = 1000;
const MAX_TOOL_TEXT_LENGTH = 200;
const ELLIPSIS = "…";

export type AssistantMessageKind = "user" | "assistant" | "tool" | "notice";

export interface AssistantMessageRow {
  id: string;
  serverId: string;
  workspaceId: string | null;
  agentId: string;
  agentName: string;
  kind: AssistantMessageKind;
  createdAt: string | null;
  text: string;
}

/** The part of a fetched timeline entry a message row is built from. */
export interface AssistantTimelineEntry {
  item: AgentTimelineItem;
  timestamp: string;
  seqEnd: number;
}

export interface AssistantMessageAgent {
  serverId: string;
  agentId: string;
  agentName: string;
  workspaceId: string | null;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function toolText(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const display = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    detail: item.detail,
    metadata: item.metadata,
  });
  const summary = oneLine(display.summary);
  return summary ? `${display.displayName}: ${summary}` : display.displayName;
}

function rowId(entry: AssistantTimelineEntry): string {
  const item = entry.item;
  const messageId =
    item.type === "user_message" || item.type === "assistant_message" ? item.messageId : null;
  return timelineItemIdentity(item) ?? messageId ?? `seq:${entry.seqEnd}`;
}

function createdAt(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function makeRow(
  agent: AssistantMessageAgent,
  entry: AssistantTimelineEntry,
  kind: AssistantMessageKind,
  raw: string,
  max: number,
): AssistantMessageRow | null {
  const text = clip(raw, max);
  if (!text) {
    return null;
  }
  return {
    id: rowId(entry),
    serverId: agent.serverId,
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
    agentName: agent.agentName,
    kind,
    createdAt: createdAt(entry.timestamp),
    text,
  };
}

function toRow(
  agent: AssistantMessageAgent,
  entry: AssistantTimelineEntry,
): AssistantMessageRow | null {
  const item = entry.item;
  switch (item.type) {
    case "user_message":
      return makeRow(agent, entry, "user", item.text, MAX_TEXT_LENGTH);
    case "assistant_message":
      return makeRow(agent, entry, "assistant", item.text, MAX_TEXT_LENGTH);
    case "tool_call":
      return makeRow(agent, entry, "tool", toolText(item), MAX_TOOL_TEXT_LENGTH);
    default:
      return null;
  }
}

/**
 * The newest messages of one agent, most recent first. Reasoning, todos, and
 * the rest of the timeline are dropped: an assistant reads these out loud, so
 * only what the user said, what the agent said, and which tool it reached for
 * survive.
 */
export function buildAssistantMessageRows(
  agent: AssistantMessageAgent,
  entries: readonly AssistantTimelineEntry[],
  limit: number,
): AssistantMessageRow[] {
  const rows: AssistantMessageRow[] = [];
  for (let index = entries.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const row = toRow(agent, entries[index]);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

/** Interleaves per-agent rows by time and keeps the newest `limit` overall. */
export function mergeAssistantMessageRows(
  groups: readonly (readonly AssistantMessageRow[])[],
  limit: number,
): AssistantMessageRow[] {
  return groups
    .flat()
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, limit);
}

export function assistantNoticeRow(input: {
  text: string;
  serverId?: string | null;
  workspaceId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
}): AssistantMessageRow {
  return {
    id: "notice",
    serverId: input.serverId ?? "",
    workspaceId: input.workspaceId ?? null,
    agentId: input.agentId ?? "",
    agentName: input.agentName ?? "",
    kind: "notice",
    createdAt: null,
    text: input.text,
  };
}
