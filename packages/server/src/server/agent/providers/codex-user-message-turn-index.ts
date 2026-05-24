import { promises as fs } from "node:fs";

const USER_MESSAGE_RECORD_TYPES = new Set(["event_msg", "response_item"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readStringField(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      if (!isRecord(entry)) {
        return "";
      }
      return readStringField(entry, ["text", "message"]) ?? "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractMessageText(message: unknown): string {
  if (typeof message === "string") {
    return message.trim();
  }
  if (!isRecord(message)) {
    return "";
  }
  return readStringField(message, ["message", "text"])?.trim() ?? "";
}

function isSyntheticRolloutUserMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  if (lower.startsWith("# agents.md instructions for") && lower.includes("<instructions>")) {
    return true;
  }
  if (lower.startsWith("<environment_context>")) {
    return true;
  }
  return false;
}

function readPayload(record: Record<string, unknown>): Record<string, unknown> | null {
  const payload = record.payload ?? record.item ?? record.msg;
  return isRecord(payload) ? payload : null;
}

function readUserMessageId(payload: Record<string, unknown>): string | null {
  return readStringField(payload, ["id", "messageId", "message_id"]);
}

function readUserMessageText(payload: Record<string, unknown>): string {
  if (payload.type === "message" && payload.role === "user") {
    return extractContentText(payload.content);
  }
  if (payload.type === "user_message") {
    return extractMessageText(payload.message);
  }
  return "";
}

function isRolloutUserMessage(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  if (!USER_MESSAGE_RECORD_TYPES.has(String(record.type))) {
    return false;
  }
  return (payload.type === "message" && payload.role === "user") || payload.type === "user_message";
}

export async function findUserMessageTurnIndex(
  rolloutPath: string,
  paseoMessageId: string,
): Promise<number | null> {
  // The caller must pass an id that Paseo previously persisted into the rollout
  // user-message record; real Codex rollouts do not automatically include Paseo's
  // canonical timeline message id.
  const targetId = paseoMessageId.trim();
  if (!targetId) {
    return null;
  }

  const content = await fs.readFile(rolloutPath, "utf8");
  let turnIndex = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const payload = readPayload(parsed);
    if (!payload || !isRolloutUserMessage(parsed, payload)) {
      continue;
    }
    const text = readUserMessageText(payload);
    if (!text || isSyntheticRolloutUserMessage(text)) {
      continue;
    }
    if (readUserMessageId(payload) === targetId) {
      return turnIndex;
    }
    turnIndex += 1;
  }
  return null;
}

export async function countRolloutUserMessageTurns(rolloutPath: string): Promise<number> {
  const content = await fs.readFile(rolloutPath, "utf8");
  let turnCount = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const payload = readPayload(parsed);
    if (!payload || !isRolloutUserMessage(parsed, payload)) {
      continue;
    }
    const text = readUserMessageText(payload);
    if (!text || isSyntheticRolloutUserMessage(text)) {
      continue;
    }
    turnCount += 1;
  }
  return turnCount;
}
