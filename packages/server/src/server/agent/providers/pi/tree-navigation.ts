import { readFileSync } from "node:fs";

interface PiTreeEntry {
  id: string;
  parentId: string | null;
  timestampMs: number | null;
  record: Record<string, unknown>;
}

export interface PiUserTreeEntry {
  id: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringMember(record: unknown, keys: readonly string[]): string | null {
  if (!isRecord(record)) return null;
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return null;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDateMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function getPiEntryId(entry: unknown): string | null {
  return readStringMember(entry, ["id", "entryId", "messageId", "nodeId"]);
}

function getPiEntryParentId(entry: unknown): string | null {
  return readStringMember(entry, ["parentId", "parent", "parentEntryId", "previousId", "prevId"]);
}

function readPiTreeEntries(sessionFile: string | undefined): PiTreeEntry[] {
  if (!sessionFile) return [];
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }

  const entries: PiTreeEntry[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const record = parseJsonRecord(rawLine.trim());
    if (!record || record.type === "session") continue;
    const id = getPiEntryId(record);
    if (!id) continue;
    entries.push({
      id,
      parentId: getPiEntryParentId(record),
      timestampMs: parseDateMs(record.timestamp),
      record,
    });
  }
  return entries;
}

function getPiMessage(entry: PiTreeEntry): Record<string, unknown> | null {
  if (isRecord(entry.record.message)) {
    return entry.record.message;
  }
  return entry.record;
}

function getPiMessageRole(message: Record<string, unknown> | null): "user" | "assistant" | null {
  const role = readString(message?.role);
  return role === "user" || role === "assistant" ? role : null;
}

function extractPiUserText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n\n")
    .trim();
}

export function resolvePiNavigationLeafId(
  sessionFile: string | undefined,
  targetId: string,
): string | null {
  const entries = readPiTreeEntries(sessionFile);
  const entry = entries.find((candidate) => candidate.id === targetId);
  if (!entry) {
    return targetId;
  }
  const message = getPiMessage(entry);
  const role = getPiMessageRole(message);
  return role === "user" ? entry.parentId : targetId;
}

export function getPiUserTreeEntries(sessionFile: string | undefined): PiUserTreeEntry[] {
  return readPiTreeEntries(sessionFile).flatMap((entry) => {
    const message = getPiMessage(entry);
    if (!message || getPiMessageRole(message) !== "user") {
      return [];
    }
    return [{ id: entry.id, text: extractPiUserText(message.content) }];
  });
}
