import { readFile } from "node:fs/promises";

import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiAgentMessage } from "./rpc-types.js";
import { parseToolResult, type PiToolResult } from "./tool-call-mapper.js";

const PI_PROVIDER = "pi";
export const MAX_SUBAGENT_TIMELINE_ROWS = 200;

export interface PiSubagentLaunchArgs {
  agent?: string;
  task?: string;
}

export interface PiSubagentProgress {
  activityState?: string;
  model?: string;
}

export interface PiSubagentResultEntry {
  agent?: string;
  task?: string;
  model?: string;
  exitCode?: number;
  error?: string;
  interrupted?: boolean;
  stopped?: boolean;
  timedOut?: boolean;
  sessionFile?: string;
  progress?: PiSubagentProgress;
}

export interface PiSubagentRunPayload {
  mode?: string;
  runId?: string;
  asyncId?: string;
  results: PiSubagentResultEntry[];
}

/** Read the model-facing launch args (`agent`, `task`) from tool call arguments. */
export function readPiSubagentLaunchArgs(args: unknown): PiSubagentLaunchArgs | null {
  if (!isRecord(args)) {
    return null;
  }
  const agent = readText(args.agent);
  const task = readText(args.task);
  if (agent === undefined && task === undefined) {
    return null;
  }
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(task === undefined ? {} : { task }),
  };
}

/**
 * Find the `subagent` tool call arguments for a tool result in parent history,
 * so replay can recover the original `agent`/`task` presentation.
 */
export function findPiSubagentCallArgs(
  messages: readonly PiAgentMessage[],
  toolCallId: string,
): unknown {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "toolCall" && block.id === toolCallId && block.name === "subagent") {
        return block.arguments;
      }
    }
  }
  return null;
}

/**
 * Read the pi-subagents run payload out of a tool result. Stored under
 * `details` on result objects; requires a `results` array to count as a run.
 */
export function readPiSubagentRunPayload(rawResult: unknown): PiSubagentRunPayload | null {
  const result = parseToolResult(rawResult);
  if (!result || typeof result === "string") {
    return null;
  }
  const details = result.details;
  if (!isRecord(details) || !Array.isArray(details.results)) {
    return null;
  }
  return {
    ...(readText(details.mode) === undefined ? {} : { mode: readText(details.mode) }),
    ...(readText(details.runId) === undefined ? {} : { runId: readText(details.runId) }),
    ...(readText(details.asyncId) === undefined ? {} : { asyncId: readText(details.asyncId) }),
    results: details.results.filter(isRecord) as PiSubagentResultEntry[],
  };
}

/** Descriptor id for a run: pi-subagents' run id when known, host tool-call id otherwise. */
export function piSubagentDescriptorId(
  toolCallId: string,
  run: Pick<PiSubagentRunPayload, "runId" | "asyncId"> | null,
): string {
  return run?.runId ?? run?.asyncId ?? toolCallId;
}

/** "explore · ox-alpha (nous_portal)" style compact context for the shared track. */
export function buildPiSubagentSubtitle(
  model: string | undefined,
  activity: string | undefined,
): string | null {
  const parts: string[] = [];
  if (activity) {
    parts.push(activity);
  }
  if (model) {
    const separator = model.indexOf("/");
    parts.push(separator > 0 ? model.slice(separator + 1) : model);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function piSubagentStatusFromResult(isError: boolean): "completed" | "failed" {
  return isError ? "failed" : "completed";
}

/**
 * Inline tool output used as a fallback timeline row when no child transcript
 * exists on disk (launch failure, async run, or stripped details).
 */
export function readPiSubagentInlineOutput(result: unknown): string | null {
  const parsed: PiToolResult = parseToolResult(result);
  if (!parsed) {
    return null;
  }
  const parts: string[] = [];
  if (typeof parsed === "string") {
    parts.push(parsed);
  } else {
    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    const direct = parsed.output ?? parsed.stdout ?? parsed.text;
    if (typeof direct === "string" && direct) {
      parts.push(direct);
    }
  }
  const joined = parts.join("\n").trim();
  return joined ? truncateText(joined) : null;
}

export function truncateText(text: string, max = 4_000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function piSubagentTimelineEvents(
  id: string,
  items: AgentTimelineItem[],
): AgentStreamEvent[] {
  return items.map((item) => ({
    type: "provider_subagent" as const,
    provider: PI_PROVIDER,
    event: {
      type: "timeline" as const,
      id,
      item,
    },
  }));
}

/**
 * Replay a completed child session file (standard Pi session JSONL) as
 * timeline items. Yields parent-visible rows only: user prompts, assistant
 * text, reasoning, tool calls/results.
 */
export async function* streamPiChildSessionItems(
  sessionFile: string,
): AsyncGenerator<{ item: AgentTimelineItem; timestamp: string | null }> {
  const entries = await readChildSessionEntries(sessionFile);
  const messages: PiAgentMessage[] = [];
  const timestamps: (string | null)[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (!isRecord(message) || typeof message.role !== "string") {
      continue;
    }
    if (!["user", "assistant", "toolResult", "custom"].includes(message.role)) {
      continue;
    }
    messages.push(message as unknown as PiAgentMessage);
    timestamps.push(normalizeTimestamp(entry.timestamp));
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    for (const item of mapPiChildMessageItems(message)) {
      yield { item, timestamp: timestamps[index] };
    }
  }
}

function mapPiChildMessageItems(message: PiAgentMessage): AgentTimelineItem[] {
  switch (message.role) {
    case "user": {
      const text = readChildUserText(message.content);
      return text ? [{ type: "user_message", text }] : [];
    }
    case "custom": {
      const text = readChildUserText(message.content);
      return text ? [{ type: "assistant_message", text }] : [];
    }
    case "assistant": {
      const items: AgentTimelineItem[] = [];
      for (const content of message.content) {
        if (content.type === "text" && content.text) {
          items.push({ type: "assistant_message", text: content.text });
        } else if (content.type === "thinking" && content.thinking) {
          items.push({ type: "reasoning", text: content.thinking });
        } else if (content.type === "toolCall") {
          items.push({
            type: "tool_call",
            callId: content.id,
            name: content.name,
            status: "completed",
            detail: { type: "unknown", input: content.arguments ?? null, output: null },
            error: null,
          });
        }
      }
      return items;
    }
    case "toolResult": {
      const errorText = message.isError
        ? (readChildUserText(message.content) ?? "Tool call failed")
        : null;
      const detail: AgentTimelineItem =
        message.isError === true
          ? {
              type: "tool_call",
              callId: message.toolCallId,
              name: message.toolName,
              status: "failed",
              detail: { type: "unknown", input: null, output: message.content ?? null },
              error: errorText,
            }
          : {
              type: "tool_call",
              callId: message.toolCallId,
              name: message.toolName,
              status: "completed",
              detail: { type: "unknown", input: null, output: message.content ?? null },
              error: null,
            };
      return [detail];
    }
    default:
      return [];
  }
}

function readChildUserText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("\n\n");
  return joined.trim() ? joined : null;
}

interface PiSessionFileEntry {
  type?: string;
  timestamp?: string | number;
  message?: unknown;
}

async function readChildSessionEntries(sessionFile: string): Promise<PiSessionFileEntry[]> {
  let content: string;
  try {
    content = await readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line) as PiSessionFileEntry;
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const timestamp = value.trim();
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      return null;
    }
    return timestamp;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const timestampMs = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
