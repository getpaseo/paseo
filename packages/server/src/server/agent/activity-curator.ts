import { Buffer } from "node:buffer";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { MAX_AGENT_CONTEXT_ATTACHMENT_BYTES } from "@getpaseo/protocol/agent-context-limits";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { isLikelyExternalToolName } from "@getpaseo/protocol/tool-name-normalization";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { projectTimelineRows } from "./timeline-projection.js";

const DEFAULT_MAX_ITEMS = 0;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_SUMMARY_CHARS = 200;

interface ActivityCuratorOptions {
  maxItems?: number;
  labelAssistantMessages?: boolean;
  includeKinds?: readonly AgentTimelineItem["type"][];
  includeExternalToolInput?: boolean;
  includeToolSummary?: boolean;
  includeSubAgentLog?: boolean;
  portableToolMarkersOnly?: boolean;
}

interface ActivityEntry {
  text: string;
}

type TextAgentAttachment = Extract<AgentAttachment, { type: "text" }>;

function appendText(buffer: string, text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return buffer;
  }
  if (!buffer) {
    return normalized;
  }
  return `${buffer}\n${normalized}`;
}

function activityEntry(text: string): ActivityEntry {
  return { text };
}

function flushBuffers(
  entries: ActivityEntry[],
  buffers: { message: string; thought: string },
  options?: ActivityCuratorOptions,
) {
  if (buffers.message.trim()) {
    const text = buffers.message.trim();
    entries.push(activityEntry(options?.labelAssistantMessages ? `[Assistant] ${text}` : text));
  }
  if (buffers.thought.trim()) {
    const text = buffers.thought.trim();
    entries.push(activityEntry(`[Thought] ${text}`));
  }
  buffers.message = "";
  buffers.thought = "";
}

function formatToolInputJson(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  try {
    const encoded = JSON.stringify(input);
    if (!encoded) {
      return null;
    }
    if (encoded.length <= MAX_TOOL_INPUT_CHARS) {
      return encoded;
    }
    return `${encoded.slice(0, MAX_TOOL_INPUT_CHARS)}...`;
  } catch {
    return null;
  }
}

function formatToolSummary(summary: string | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TOOL_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
}

function inputFromUnknownDetail(
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): unknown {
  return detail.type === "unknown" ? detail.input : null;
}

function projectForCuration(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const rows = items.map((item, index) => ({
    seq: index + 1,
    timestamp: "",
    item,
  }));
  return projectTimelineRows({ rows, mode: "projected" }).map((entry) => entry.item);
}

function shouldIncludeItem(item: AgentTimelineItem, options?: ActivityCuratorOptions): boolean {
  if (!options?.includeKinds) {
    return true;
  }
  return options.includeKinds.includes(item.type);
}

function formatToolCallEntry(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  options?: ActivityCuratorOptions,
): ActivityEntry {
  const inputJson = formatToolInputJson(inputFromUnknownDetail(item.detail));
  const display = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    detail: item.detail,
    metadata: item.metadata,
  });
  const displayName = options?.portableToolMarkersOnly
    ? getPortableToolMarker(item.detail)
    : display.displayName;
  const summary = options?.includeToolSummary === false ? null : formatToolSummary(display.summary);
  if (
    (options?.includeExternalToolInput ?? true) &&
    isLikelyExternalToolName(item.name) &&
    inputJson
  ) {
    return activityEntry(`[${displayName}] ${inputJson}`);
  }
  return activityEntry(summary ? `[${displayName}] ${summary}` : `[${displayName}]`);
}

/**
 * Agent-context attachments may cross providers and should never expose
 * provider-owned tool names, inputs, summaries, or subagent logs. Keep their
 * tool markers to the small Paseo-owned vocabulary below.
 */
function getPortableToolMarker(
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): string {
  switch (detail.type) {
    case "shell":
      return "Shell";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "search":
      return "Search";
    case "fetch":
      return "Fetch";
    case "worktree_setup":
      return "Worktree Setup";
    case "sub_agent":
      return "Task";
    case "plan":
      return "Plan";
    case "plain_text":
    case "unknown":
      return "Tool";
    default:
      return "Tool";
  }
}

function appendSubAgentLog(
  entries: ActivityEntry[],
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  options?: ActivityCuratorOptions,
): void {
  if (options?.includeSubAgentLog === false || item.detail.type !== "sub_agent") {
    return;
  }
  const log = item.detail.log.trim();
  if (log) {
    entries.push(activityEntry(log));
  }
}

function curateProjectedActivityEntries(
  items: readonly AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): ActivityEntry[] {
  if (items.length === 0) {
    return [];
  }

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const recentItems = maxItems > 0 && items.length > maxItems ? items.slice(-maxItems) : items;

  const entries: ActivityEntry[] = [];
  const buffers = { message: "", thought: "" };

  for (const item of recentItems) {
    if (!shouldIncludeItem(item, options)) {
      continue;
    }

    switch (item.type) {
      case "user_message":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry(`[User] ${item.text.trim()}`));
        break;
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "tool_call": {
        flushBuffers(entries, buffers, options);
        entries.push(formatToolCallEntry(item, options));
        appendSubAgentLog(entries, item, options);
        break;
      }
      case "todo":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry("[Tasks]"));
        for (const entry of item.items) {
          const checkbox = entry.completed ? "[x]" : "[ ]";
          const text = `- ${checkbox} ${entry.text}`;
          entries.push(activityEntry(text));
        }
        break;
      case "error":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry(`[Error] ${item.message}`));
        break;
      case "compaction":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry("[Compacted]"));
        break;
    }
  }

  flushBuffers(entries, buffers, options);

  return entries;
}

function curateAgentActivityEntries(
  timeline: AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): ActivityEntry[] {
  const collapsed = projectForCuration(timeline);
  return curateProjectedActivityEntries(collapsed, options);
}

/**
 * Convert normalized agent timeline items into a concise text summary.
 */
export function curateAgentActivity(
  timeline: AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): string {
  const entries = curateAgentActivityEntries(timeline, options);
  return entries.length > 0
    ? entries.map((entry) => entry.text).join("\n")
    : "No activity to display.";
}

interface ForkCursorBoundary {
  timelineEpoch: string;
  cursor: { epoch: string; seq: number };
}

function selectForkContextRows(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
}): {
  items: AgentTimelineItem[];
  boundaryCursor: { epoch: string; seq: number } | null;
  boundaryMessageId: string | null;
} {
  const boundaryCursor = input.cursorBoundary?.cursor ?? null;
  const boundaryMessageId = input.boundaryMessageId?.trim() || null;
  if (!boundaryCursor && !boundaryMessageId) {
    const projected = projectTimelineRows({ rows: input.rows, mode: "projected" });
    return {
      items: projected.map((entry) => entry.item),
      boundaryCursor: null,
      boundaryMessageId: null,
    };
  }

  if (
    input.cursorBoundary &&
    input.cursorBoundary.cursor.epoch !== input.cursorBoundary.timelineEpoch
  ) {
    throw new Error("Selected timeline position is no longer available.");
  }
  const boundaryIndex = boundaryCursor
    ? input.rows.findIndex((row) => row.seq === boundaryCursor.seq)
    : input.rows.findLastIndex(
        (row) => row.item.type === "assistant_message" && row.item.messageId === boundaryMessageId,
      );
  if (boundaryIndex < 0) {
    throw new Error(
      boundaryCursor
        ? "Selected timeline position is no longer available."
        : "Selected assistant message is no longer available.",
    );
  }
  const selectedRows = input.rows.slice(0, boundaryIndex + 1);
  const projected = projectTimelineRows({ rows: selectedRows, mode: "projected" });

  return {
    items: projected.map((entry) => entry.item),
    boundaryCursor,
    boundaryMessageId,
  };
}

function trimContextMetadata(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildForkContextText(input: {
  body: string;
  agentTitle?: string | null;
  cwd?: string | null;
}): string {
  return buildChatHistoryContextText({
    body: input.body,
    header: buildChatHistoryHeader(input),
  });
}

function buildChatHistoryHeader(input: {
  agentTitle?: string | null;
  cwd?: string | null;
}): string[] {
  const header = ["Chat history from a previous Paseo agent."];
  const agentTitle = trimContextMetadata(input.agentTitle);
  const cwd = trimContextMetadata(input.cwd);
  if (agentTitle) {
    header.push(`Source agent: ${agentTitle}`);
  }
  if (cwd) {
    header.push(`Source directory: ${cwd}`);
  }
  return header;
}

function buildChatHistoryContextText(input: { body: string; header: readonly string[] }): string {
  return `<chat-history-summary>\n${input.header.join("\n")}\n\n${input.body}\n</chat-history-summary>`;
}

export function buildAgentForkContextAttachment(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
  agentTitle?: string | null;
  cwd?: string | null;
}): {
  attachment: TextAgentAttachment;
  itemCount: number;
  boundaryCursor: { epoch: string; seq: number } | null;
  boundaryMessageId: string | null;
} {
  const selected = selectForkContextRows({
    rows: input.rows,
    cursorBoundary: input.cursorBoundary,
    boundaryMessageId: input.boundaryMessageId,
  });
  const entries = curateProjectedActivityEntries(selected.items, {
    maxItems: 0,
    labelAssistantMessages: true,
    includeKinds: ["user_message", "assistant_message", "tool_call"],
    includeExternalToolInput: false,
  });
  const body =
    entries.length > 0
      ? entries.map((entry) => entry.text).join("\n")
      : "No chat history to display.";
  return {
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: buildForkContextText({
        body,
        agentTitle: input.agentTitle,
        cwd: input.cwd,
      }),
    },
    itemCount: selected.items.length,
    boundaryCursor: selected.boundaryCursor,
    boundaryMessageId: selected.boundaryMessageId,
  };
}

interface AgentContextEntry {
  text: string;
}

const EMPTY_AGENT_CONTEXT_BODY = "No chat history to display.";

export const AGENT_CONTEXT_ATTACHMENT_MIN_BYTES = 1024;
export const AGENT_CONTEXT_ATTACHMENT_MAX_BYTES = MAX_AGENT_CONTEXT_ATTACHMENT_BYTES;

function textByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Keep the daemon's context policy authoritative even if another server caller
 * passes a malformed or future size value.
 */
export function resolveAgentContextAttachmentMaxBytes(maxBytes?: number): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) {
    return AGENT_CONTEXT_ATTACHMENT_MAX_BYTES;
  }
  return Math.min(
    AGENT_CONTEXT_ATTACHMENT_MAX_BYTES,
    Math.max(AGENT_CONTEXT_ATTACHMENT_MIN_BYTES, Math.floor(maxBytes)),
  );
}

function buildBoundedAgentContextShell(input: {
  maxBytes: number;
  agentTitle?: string | null;
  cwd?: string | null;
}): { prefix: string; suffix: string } {
  const header = ["Chat history from a previous Paseo agent."];
  const optionalHeaderLines = buildChatHistoryHeader(input).slice(1);
  const suffix = "\n</chat-history-summary>";

  for (const line of optionalHeaderLines) {
    const candidateHeader = [...header, line];
    const candidatePrefix = `<chat-history-summary>\n${candidateHeader.join("\n")}\n\n`;
    if (
      textByteLength(candidatePrefix) +
        textByteLength(EMPTY_AGENT_CONTEXT_BODY) +
        textByteLength(suffix) <=
      input.maxBytes
    ) {
      header.push(line);
    }
  }

  return {
    prefix: `<chat-history-summary>\n${header.join("\n")}\n\n`,
    suffix,
  };
}

function curateAgentContextEntries(items: readonly AgentTimelineItem[]): AgentContextEntry[] {
  return items.flatMap((item) => {
    const entries = curateProjectedActivityEntries([item], {
      labelAssistantMessages: true,
      includeKinds: ["user_message", "assistant_message", "tool_call"],
      includeExternalToolInput: false,
      includeToolSummary: false,
      includeSubAgentLog: false,
      portableToolMarkersOnly: true,
    });
    return entries.length > 0 ? [{ text: entries.map((entry) => entry.text).join("\n") }] : [];
  });
}

function estimateAgentContextItemBytes(item: AgentTimelineItem): number | null {
  switch (item.type) {
    case "user_message":
      return textByteLength(item.text) + textByteLength("[User] \n");
    case "assistant_message":
      return textByteLength(item.text) + textByteLength("[Assistant] \n");
    case "tool_call":
      return textByteLength("[Worktree Setup]\n");
    default:
      return null;
  }
}

function mergeAgentContextToolRows(
  earlier: AgentTimelineRow,
  latest: AgentTimelineRow,
): AgentTimelineRow {
  if (earlier.item.type !== "tool_call" || latest.item.type !== "tool_call") {
    return latest;
  }
  const detail =
    latest.item.detail.type === "unknown" && earlier.item.detail.type !== "unknown"
      ? earlier.item.detail
      : latest.item.detail;
  return {
    ...earlier,
    item: {
      ...latest.item,
      detail,
    },
  };
}

/**
 * Bound work before projection. Histories can contain tens of thousands of
 * rows (including large reasoning/tool payloads) even though the resulting
 * model context is small. Keep only the newest relevant suffix whose maximum
 * rendered size can fit, preserving original sequence gaps so projection does
 * not merge messages that excluded rows separated.
 */
function selectAgentContextCandidateRows(input: {
  rows: readonly AgentTimelineRow[];
  maxBodyBytes: number;
}): { rows: AgentTimelineRow[]; truncated: boolean } {
  const selectedRows: AgentTimelineRow[] = [];
  const toolIndexByCallId = new Map<string, number>();
  let remainingBytes = Math.max(0, input.maxBodyBytes);

  for (let index = input.rows.length - 1; index >= 0; index -= 1) {
    const row = input.rows[index];
    if (row.item.type === "tool_call") {
      const existingIndex = toolIndexByCallId.get(row.item.callId);
      if (existingIndex !== undefined) {
        const latest = selectedRows[existingIndex];
        selectedRows[existingIndex] = mergeAgentContextToolRows(row, latest);
        continue;
      }
    }
    const estimatedBytes = estimateAgentContextItemBytes(row.item);
    if (estimatedBytes === null) {
      continue;
    }
    if (estimatedBytes > remainingBytes) {
      return {
        rows: selectedRows.toSorted((left, right) => left.seq - right.seq),
        truncated: true,
      };
    }
    selectedRows.push(row);
    if (row.item.type === "tool_call") {
      toolIndexByCallId.set(row.item.callId, selectedRows.length - 1);
    }
    remainingBytes -= estimatedBytes;
  }

  return {
    rows: selectedRows.toSorted((left, right) => left.seq - right.seq),
    truncated: false,
  };
}

/**
 * Resolve a local agent reference into a privacy-curated, bounded chat-history
 * text attachment. Entries are retained as a contiguous newest suffix, so no
 * message or marker is cut in half when a source has a long history.
 */
export function buildAgentContextAttachment(input: {
  rows: readonly AgentTimelineRow[];
  /** True when the caller intentionally supplied only a bounded recent window. */
  hasOlderRows?: boolean;
  maxBytes?: number;
  agentTitle?: string | null;
  cwd?: string | null;
}): {
  attachment: TextAgentAttachment;
  includedItemCount: number;
  byteCount: number;
  truncated: boolean;
} {
  const maxBytes = resolveAgentContextAttachmentMaxBytes(input.maxBytes);
  const shell = buildBoundedAgentContextShell({
    maxBytes,
    agentTitle: input.agentTitle,
    cwd: input.cwd,
  });
  const availableBodyBytes = maxBytes - textByteLength(shell.prefix) - textByteLength(shell.suffix);
  const candidates = selectAgentContextCandidateRows({
    rows: input.rows,
    maxBodyBytes: availableBodyBytes,
  });
  const selected = selectForkContextRows({ rows: candidates.rows });
  const entries = curateAgentContextEntries(selected.items);
  const retainedNewestFirst: AgentContextEntry[] = [];
  let retainedBytes = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const separatorBytes = retainedNewestFirst.length > 0 ? textByteLength("\n") : 0;
    const nextBytes = retainedBytes + separatorBytes + textByteLength(entry.text);
    if (nextBytes > availableBodyBytes) {
      break;
    }
    retainedNewestFirst.push(entry);
    retainedBytes = nextBytes;
  }
  const retained = retainedNewestFirst.toReversed();
  const body =
    retained.length > 0 ? retained.map((entry) => entry.text).join("\n") : EMPTY_AGENT_CONTEXT_BODY;
  const text = `${shell.prefix}${body}${shell.suffix}`;

  return {
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text,
    },
    includedItemCount: retained.length,
    byteCount: textByteLength(text),
    truncated:
      Boolean(input.hasOlderRows) || candidates.truncated || retained.length < entries.length,
  };
}
