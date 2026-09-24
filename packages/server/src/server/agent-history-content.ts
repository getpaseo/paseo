import { open, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Node 22 ships this module. The repo's Node 20 type package does not.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(filename: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
    };
    close(): void;
  }
}

/**
 * Persisted conversation text for history search.
 *
 * The on-screen timeline is a window. Searching that window misses every
 * message that is not loaded, which is why history search used to stay on
 * names. This reads the provider's own session store instead.
 */

const MAX_READ_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 200_000;
const HEAD_CHARS = 80_000;

export interface HistoryContentAgent {
  provider?: string;
  persistence?: { provider?: string; sessionId?: string | null } | null;
}

export interface HistoryContentRoots {
  grokSessionsDir: string;
  claudeProjectsDir: string;
  cursorSessionsDir: string;
  opencodeDbPath: string;
}

export function defaultHistoryContentRoots(home = homedir()): HistoryContentRoots {
  return {
    grokSessionsDir: path.join(home, ".grok", "sessions"),
    claudeProjectsDir: path.join(home, ".claude", "projects"),
    cursorSessionsDir: path.join(home, ".cursor", "acp-sessions"),
    opencodeDbPath: path.join(home, ".local", "share", "opencode", "opencode.db"),
  };
}

const fileIndexes = new Map<string, Promise<Map<string, string>>>();
const textCache = new Map<string, string>();

export function clearAgentHistoryContentCache(): void {
  fileIndexes.clear();
  textCache.clear();
}

export function conversationTextFromGrokJsonl(raw: string): string {
  return conversationTextFromLines(raw, (row) => {
    const type = stringField(row, "type");
    if (type !== "user" && type !== "assistant" && type !== "tool_result") return "";
    return textFromContent(row.content);
  });
}

export function conversationTextFromClaudeJsonl(raw: string): string {
  return conversationTextFromLines(raw, (row) => {
    const type = stringField(row, "type");
    if (type !== "user" && type !== "assistant") return "";
    const message = row.message;
    if (!message || typeof message !== "object") return "";
    return textFromContent((message as { content?: unknown }).content);
  });
}

export function conversationTextFromCursorBlobs(blobs: readonly Uint8Array[]): string {
  const parts: string[] = [];
  for (const blob of blobs) {
    if (blob.length === 0 || blob[0] !== 0x7b) continue;
    let row: unknown;
    try {
      row = JSON.parse(Buffer.from(blob).toString("utf8"));
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const role = stringField(row as Record<string, unknown>, "role");
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromContent((row as { content?: unknown }).content);
    if (text) parts.push(text);
  }
  return capText(parts.join("\n"));
}

export function conversationTextFromOpenCodeParts(rows: readonly string[]): string {
  const parts: string[] = [];
  for (const raw of rows) {
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const record = row as { type?: unknown; text?: unknown; summary?: unknown };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    if (typeof record.summary === "string") parts.push(record.summary);
  }
  return capText(parts.join("\n"));
}

export async function loadAgentHistoryContent(
  agent: HistoryContentAgent,
  roots: HistoryContentRoots = defaultHistoryContentRoots(),
): Promise<string> {
  const sessionId = safeSessionId(agent.persistence?.sessionId);
  if (!sessionId) return "";
  const provider = agent.provider || agent.persistence?.provider || "";
  try {
    switch (provider) {
      case "grok":
        return await readIndexedFile(
          roots.grokSessionsDir,
          sessionId,
          "grok",
          conversationTextFromGrokJsonl,
        );
      case "claude":
        return await readIndexedFile(
          roots.claudeProjectsDir,
          sessionId,
          "claude",
          conversationTextFromClaudeJsonl,
        );
      case "cursor":
        return await readCursorSession(path.join(roots.cursorSessionsDir, sessionId, "store.db"));
      case "opencode":
        return await readOpenCodeSession(roots.opencodeDbPath, sessionId);
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function conversationTextFromLines(
  raw: string,
  pick: (row: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const text = pick(row as Record<string, unknown>);
    if (text) parts.push(text);
  }
  return capText(parts.join("\n"));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const bits: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      bits.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (typeof record.text !== "string") continue;
    if (record.type !== undefined && record.type !== "text" && record.type !== "output_text")
      continue;
    bits.push(record.text);
  }
  return bits.join("\n");
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const tail = MAX_TEXT_CHARS - HEAD_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n${text.slice(text.length - tail)}`;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function safeSessionId(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) return null;
  return sessionId;
}

async function readIndexedFile(
  root: string,
  sessionId: string,
  kind: string,
  extract: (raw: string) => string,
): Promise<string> {
  const index = await fileIndex(
    kind,
    root,
    kind === "grok" ? indexGrokSessions : indexClaudeSessions,
  );
  const file = index.get(sessionId);
  if (!file) return "";
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return "";
  const cacheKey = `${file}\0${info.mtimeMs}:${info.size}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const text = extract(await readBounded(file));
  textCache.set(cacheKey, text);
  return text;
}

function fileIndex(
  kind: string,
  root: string,
  build: (root: string) => Promise<Map<string, string>>,
): Promise<Map<string, string>> {
  const key = `${kind}\0${root}`;
  const existing = fileIndexes.get(key);
  if (existing) return existing;
  const built = build(root);
  fileIndexes.set(key, built);
  return built;
}

async function indexGrokSessions(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const cwdName of await readDirNames(root)) {
    const cwdDir = path.join(root, cwdName);
    for (const sessionId of await readDirNames(cwdDir)) {
      map.set(sessionId, path.join(cwdDir, sessionId, "chat_history.jsonl"));
    }
  }
  return map;
}

async function indexClaudeSessions(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await walkClaude(root, map);
  return map;
}

async function walkClaude(dir: string, map: Map<string, string>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "subagents") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkClaude(full, map);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      map.set(entry.name.slice(0, -".jsonl".length), full);
    }
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readBounded(file: string): Promise<string> {
  const info = await stat(file);
  const handle = await open(file, "r");
  try {
    if (info.size <= MAX_READ_BYTES) {
      return await handle.readFile({ encoding: "utf8" });
    }
    const head = Buffer.alloc(MAX_READ_BYTES / 2);
    const tail = Buffer.alloc(MAX_READ_BYTES / 2);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, info.size - tail.length);
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

async function readCursorSession(dbPath: string): Promise<string> {
  const info = await stat(dbPath).catch(() => null);
  if (!info?.isFile()) return "";
  const cacheKey = `${dbPath}\0${info.mtimeMs}:${info.size}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT data FROM blobs").all() as Array<{ data: Uint8Array }>;
    const text = conversationTextFromCursorBlobs(rows.map((row) => row.data));
    textCache.set(cacheKey, text);
    return text;
  } finally {
    db.close();
  }
}

async function readOpenCodeSession(dbPath: string, sessionId: string): Promise<string> {
  const info = await stat(dbPath).catch(() => null);
  if (!info?.isFile()) return "";
  const cacheKey = `${dbPath}\0${sessionId}\0${info.mtimeMs}:${info.size}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const parts = db.prepare("SELECT data FROM part WHERE session_id = ?").all(sessionId) as Array<{
      data: string;
    }>;
    const messages = db
      .prepare("SELECT data FROM message WHERE session_id = ?")
      .all(sessionId) as Array<{ data: string }>;
    const text = conversationTextFromOpenCodeParts([
      ...parts.map((row) => row.data),
      ...messages.map((row) => row.data),
    ]);
    textCache.set(cacheKey, text);
    return text;
  } finally {
    db.close();
  }
}
