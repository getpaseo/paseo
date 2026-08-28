import { readFile, stat } from "node:fs/promises";

import type { AgentProvider, AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  getUserMessageText,
  PiHistoryMapper,
  type PiCapturedUserMessageEntry,
} from "./history-mapper.js";
import type {
  PiAgentMessage,
  PiAssistantContent,
  PiImageContent,
  PiTextContent,
} from "./rpc-types.js";

export interface PiNativeHistoryMessageEntry {
  entryId: string;
  timestamp?: string;
  message: PiAgentMessage;
}

export interface PiNativeHistory {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  entries: PiNativeHistoryMessageEntry[];
  latestEntryId: string | null;
  lastActivityAt: Date | null;
}

export interface PiNativeHistoryEvent {
  entryId: string;
  event: AgentStreamEvent;
}

export async function readPiNativeHistory(sessionFile: string): Promise<PiNativeHistory> {
  const text = await readFile(sessionFile, "utf8");
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let lastActivityAt: Date | null = await readMtime(sessionFile);
  const entries: PiNativeHistoryMessageEntry[] = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const record = parseJsonRecord(rawLine.trim());
    if (!record) {
      continue;
    }

    const timestamp = readTimestamp(record.timestamp);
    if (timestamp) {
      lastActivityAt = new Date(timestamp);
    }

    if (record.type === "session") {
      sessionId = readString(record.id) ?? sessionId;
      cwd = readString(record.cwd) ?? cwd;
      continue;
    }

    if (record.type !== "message") {
      continue;
    }

    const entryId = readString(record.id);
    const message = toPiAgentMessage(record.message, entryId, timestamp);
    if (!entryId || !message) {
      continue;
    }
    entries.push({
      entryId,
      ...(timestamp ? { timestamp } : {}),
      message,
    });
  }

  if (!sessionId) {
    throw new Error(`Pi native history is missing a session header: ${sessionFile}`);
  }
  if (!cwd) {
    throw new Error(`Pi native history is missing a cwd: ${sessionFile}`);
  }

  return {
    sessionFile,
    sessionId,
    cwd,
    entries,
    latestEntryId: entries.at(-1)?.entryId ?? null,
    lastActivityAt,
  };
}

export function mapPiNativeHistoryEvents(
  history: PiNativeHistory,
  provider: AgentProvider,
): PiNativeHistoryEvent[] {
  const mapper = new PiHistoryMapper(provider, extractCapturedUserEntries(history.entries));
  const events: PiNativeHistoryEvent[] = [];

  for (const entry of history.entries) {
    for (const event of mapper.mapMessages([entry.message])) {
      events.push({
        entryId: entry.entryId,
        event:
          event.type === "timeline" && entry.timestamp
            ? { ...event, timestamp: entry.timestamp }
            : event,
      });
    }
  }

  return events;
}

export function selectPiNativeHistoryEventsAfter(
  events: readonly PiNativeHistoryEvent[],
  lastSyncedEntryId: string | null | undefined,
): PiNativeHistoryEvent[] {
  if (!lastSyncedEntryId) {
    return [...events];
  }
  const index = events.findLastIndex((event) => event.entryId === lastSyncedEntryId);
  if (index === -1) {
    throw new Error(`Native Pi history no longer contains synced entry ${lastSyncedEntryId}`);
  }
  return events.slice(index + 1);
}

function extractCapturedUserEntries(
  entries: readonly PiNativeHistoryMessageEntry[],
): PiCapturedUserMessageEntry[] {
  return entries.flatMap((entry) => {
    if (entry.message.role !== "user") {
      return [];
    }
    const text = getUserMessageText(entry.message.content);
    return text ? [{ id: entry.entryId, text }] : [];
  });
}

async function readMtime(filePath: string): Promise<Date | null> {
  try {
    return (await stat(filePath)).mtime;
  } catch {
    return null;
  }
}

function toPiAgentMessage(
  value: unknown,
  entryId: string | null,
  timestamp: string | null,
): PiAgentMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.role) {
    case "user":
      return toUserOrCustomMessage(value, "user");
    case "custom":
      return toUserOrCustomMessage(value, "custom");
    case "assistant":
      return toAssistantMessage(value, entryId);
    case "toolResult":
      return toToolResultMessage(value);
    case "bashExecution":
      return toBashExecutionMessage(value, timestamp);
    default:
      return null;
  }
}

function toUserOrCustomMessage(
  value: Record<string, unknown>,
  role: "user" | "custom",
): PiAgentMessage | null {
  const content = toTextOrImageContent(value.content);
  return content === null ? null : { role, content };
}

function toAssistantMessage(
  value: Record<string, unknown>,
  entryId: string | null,
): PiAgentMessage | null {
  if (!Array.isArray(value.content)) {
    return null;
  }
  const content = value.content.flatMap((part) => {
    const assistantPart = toAssistantContent(part);
    return assistantPart ? [assistantPart] : [];
  });
  const provider = readString(value.provider);
  const model = readString(value.model);
  const responseId = readString(value.responseId) ?? entryId;
  const responseModel = readString(value.responseModel);
  const stopReason = readString(value.stopReason);
  return {
    role: "assistant",
    content,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(responseId ? { responseId } : {}),
    ...(responseModel ? { responseModel } : {}),
    ...(typeof value.errorMessage === "string" || value.errorMessage === null
      ? { errorMessage: value.errorMessage }
      : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

function toToolResultMessage(value: Record<string, unknown>): PiAgentMessage | null {
  const toolCallId = readString(value.toolCallId);
  const toolName = readString(value.toolName);
  if (!toolCallId || !toolName) {
    return null;
  }
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: value.content,
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
  };
}

function toBashExecutionMessage(
  value: Record<string, unknown>,
  timestamp: string | null,
): PiAgentMessage | null {
  const command = readString(value.command);
  if (!command) {
    return null;
  }
  return {
    role: "bashExecution",
    command,
    ...(typeof value.output === "string" ? { output: value.output } : {}),
    ...(typeof value.exitCode === "number" || value.exitCode === null
      ? { exitCode: value.exitCode }
      : {}),
    ...(typeof value.cancelled === "boolean" ? { cancelled: value.cancelled } : {}),
    timestamp: typeof value.timestamp === "number" ? value.timestamp : timestampToMillis(timestamp),
  };
}

function timestampToMillis(timestamp: string | null): number {
  return timestamp ? Date.parse(timestamp) : 0;
}

function toTextOrImageContent(
  value: unknown,
): string | Array<PiTextContent | PiImageContent> | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const content: Array<PiTextContent | PiImageContent> = [];
  for (const part of value) {
    const textPart = toTextContent(part);
    if (textPart) {
      content.push(textPart);
      continue;
    }
    const imagePart = toImageContent(part);
    if (imagePart) {
      content.push(imagePart);
    }
  }
  return content;
}

function toAssistantContent(value: unknown): PiAssistantContent | null {
  const textPart = toTextContent(value);
  if (textPart) {
    return textPart;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "thinking" && typeof value.thinking === "string") {
    return { type: "thinking", thinking: value.thinking };
  }
  if (value.type === "toolCall") {
    const id = readString(value.id);
    const name = readString(value.name);
    if (!id || !name) {
      return null;
    }
    return { type: "toolCall", id, name, arguments: value.arguments };
  }
  return null;
}

function toTextContent(value: unknown): PiTextContent | null {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") {
    return null;
  }
  return { type: "text", text: value.text };
}

function toImageContent(value: unknown): PiImageContent | null {
  if (
    !isRecord(value) ||
    value.type !== "image" ||
    typeof value.data !== "string" ||
    typeof value.mimeType !== "string"
  ) {
    return null;
  }
  return { type: "image", data: value.data, mimeType: value.mimeType };
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
