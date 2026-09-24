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
const textCache = new Map<string, HistoryConversation>();

export function clearAgentHistoryContentCache(): void {
  fileIndexes.clear();
  textCache.clear();
}

/** User text and replies outrank thinking and tool traces. */
export type HistoryContentSource = "user" | "reply" | "thinking" | "tool";

export interface HistoryConversation {
  user: string;
  reply: string;
  thinking: string;
  tool: string;
}

export function emptyHistoryConversation(): HistoryConversation {
  return { user: "", reply: "", thinking: "", tool: "" };
}

interface HistoryBands {
  user: string[];
  reply: string[];
  thinking: string[];
  tool: string[];
}

export function conversationTextFromGrokJsonl(raw: string): HistoryConversation {
  return conversationFromLines(raw, (row, bands) => {
    const type = stringField(row, "type");
    if (type === "user") {
      pushBand(bands.user, visibleUserText(textFromContent(row.content)));
      return;
    }
    if (type === "assistant") {
      pushBand(bands.reply, textFromContent(row.content));
      pushBand(bands.tool, collectPlainText(row.tool_calls));
      return;
    }
    if (type === "tool_result") {
      pushBand(bands.tool, textFromContent(row.content));
      return;
    }
    if (type === "backend_tool_call") {
      pushBand(bands.tool, collectPlainText(row.kind ?? row));
      return;
    }
    if (type === "reasoning") {
      pushBand(bands.thinking, reasoningSummaryText(row.summary));
    }
  });
}

export function conversationTextFromClaudeJsonl(raw: string): HistoryConversation {
  return conversationFromLines(raw, (row, bands) => {
    const type = stringField(row, "type");
    if (type !== "user" && type !== "assistant") return;
    const message = row.message;
    if (!message || typeof message !== "object") return;
    readStructuredContent((message as { content?: unknown }).content, type, bands);
  });
}

export function conversationTextFromCursorBlobs(blobs: readonly Uint8Array[]): HistoryConversation {
  const bands = emptyBands();
  for (const blob of blobs) {
    if (blob.length === 0 || blob[0] !== 0x7b) continue;
    let row: unknown;
    try {
      row = JSON.parse(Buffer.from(blob).toString("utf8"));
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const role = stringField(record, "role");
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    readStructuredContent(record.content, role, bands);
  }
  return finishBands(bands);
}

export function conversationTextFromOpenCodeParts(
  rows: readonly (string | { data: string; role?: string | null })[],
): HistoryConversation {
  const bands = emptyBands();
  for (const raw of rows) readOpenCodePart(raw, bands);
  return finishBands(bands);
}

function readOpenCodePart(
  raw: string | { data: string; role?: string | null },
  bands: HistoryBands,
): void {
  const data = typeof raw === "string" ? raw : raw.data;
  const role = typeof raw === "string" ? "" : (raw.role ?? "");
  let row: unknown;
  try {
    row = JSON.parse(data);
  } catch {
    return;
  }
  if (!row || typeof row !== "object") return;
  const record = row as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "text" && typeof record.text === "string") {
    if (role === "user") pushBand(bands.user, visibleUserText(record.text));
    else pushBand(bands.reply, record.text);
    return;
  }
  if (type === "reasoning" || type === "thinking") {
    pushBand(bands.thinking, firstString(record.text, record.thinking));
    return;
  }
  if (type === "tool" || type === "tool-result" || type === "tool_result") {
    pushBand(bands.tool, typeof record.text === "string" ? record.text : collectPlainText(record));
    return;
  }
  if (typeof record.summary === "string") pushBand(bands.reply, record.summary);
}

export async function loadAgentHistoryContent(
  agent: HistoryContentAgent,
  roots: HistoryContentRoots = defaultHistoryContentRoots(),
): Promise<HistoryConversation> {
  const sessionId = safeSessionId(agent.persistence?.sessionId);
  if (!sessionId) return emptyHistoryConversation();
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
        return emptyHistoryConversation();
    }
  } catch {
    return emptyHistoryConversation();
  }
}

function conversationFromLines(
  raw: string,
  pick: (row: Record<string, unknown>, bands: HistoryBands) => void,
): HistoryConversation {
  const bands = emptyBands();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    pick(row as Record<string, unknown>, bands);
  }
  return finishBands(bands);
}

const INJECTED_USER_WRAPPERS = [
  "user_info",
  "user_rules",
  "user_rule",
  "rules",
  "system-reminder",
  "system_reminder",
];

/**
 * The typed message. `<user_query>` is that message when the tag exists.
 * `<user_info>`, `<rules>`, and system reminders are injected and must not match.
 * With no `<user_query>` tag, whatever is left after those wrappers is the message.
 */
function visibleUserText(text: string): string {
  if (text.includes("<user_query>")) {
    const parts: string[] = [];
    for (const match of text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)) {
      const inner = match[1].trim();
      if (inner) parts.push(inner);
    }
    return parts.join("\n");
  }
  let stripped = text;
  let removed = false;
  for (const tag of INJECTED_USER_WRAPPERS) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi");
    const next = stripped.replace(pattern, "");
    if (next !== stripped) removed = true;
    stripped = next;
  }
  return (removed ? stripped : text).trim();
}

function reasoningSummaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  const bits: string[] = [];
  for (const item of summary) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; text?: unknown };
    if (record.type !== "summary_text" || typeof record.text !== "string") continue;
    bits.push(record.text);
  }
  return bits.join("\n");
}

function readStructuredContent(
  content: unknown,
  role: "user" | "assistant" | "tool",
  bands: HistoryBands,
): void {
  if (typeof content === "string") {
    pushMessageText(bands, role, content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) readStructuredPart(part, role, bands);
}

function readStructuredPart(
  part: unknown,
  role: "user" | "assistant" | "tool",
  bands: HistoryBands,
): void {
  if (typeof part === "string") {
    pushMessageText(bands, role, part);
    return;
  }
  if (!part || typeof part !== "object") return;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "redacted_thinking") return;
  if (type === "thinking" || type === "reasoning") {
    pushBand(bands.thinking, firstString(record.thinking, record.text));
    return;
  }
  if (isToolPart(type) || role === "tool") {
    pushBand(bands.tool, collectPlainText(record));
    return;
  }
  if (type !== "text" && type !== "output_text" && type !== "") return;
  if (typeof record.text !== "string") return;
  pushMessageText(bands, role, record.text);
}

function pushMessageText(
  bands: HistoryBands,
  role: "user" | "assistant" | "tool",
  text: string,
): void {
  if (role === "user") {
    pushBand(bands.user, visibleUserText(text));
    return;
  }
  if (role === "assistant") {
    pushBand(bands.reply, text);
    return;
  }
  pushBand(bands.tool, text);
}

function isToolPart(type: string): boolean {
  return (
    type === "tool_use" ||
    type === "tool_result" ||
    type === "tool-call" ||
    type === "tool-result" ||
    type === "tool"
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return "";
}

const SKIPPED_TRACE_KEYS = new Set([
  "encrypted_content",
  "experimental_content",
  "id",
  "providerOptions",
  "signature",
  "status",
  "toolCallId",
  "tool_use_id",
  "type",
]);

function collectPlainText(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => collectPlainText(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object") return "";
  const bits: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SKIPPED_TRACE_KEYS.has(key)) continue;
    const text = collectPlainText(child, depth + 1);
    if (text) bits.push(text);
  }
  return bits.join("\n");
}

function emptyBands(): HistoryBands {
  return { user: [], reply: [], thinking: [], tool: [] };
}

function pushBand(bucket: string[], text: string): void {
  const trimmed = text.trim();
  if (trimmed) bucket.push(trimmed);
}

function finishBands(bands: HistoryBands): HistoryConversation {
  return {
    user: capText(bands.user.join("\n")),
    reply: capText(bands.reply.join("\n")),
    thinking: capText(bands.thinking.join("\n")),
    tool: capText(bands.tool.join("\n")),
  };
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
  extract: (raw: string) => HistoryConversation,
): Promise<HistoryConversation> {
  const index = await fileIndex(
    kind,
    root,
    kind === "grok" ? indexGrokSessions : indexClaudeSessions,
  );
  const file = index.get(sessionId);
  if (!file) return emptyHistoryConversation();
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return emptyHistoryConversation();
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

async function readCursorSession(dbPath: string): Promise<HistoryConversation> {
  const info = await stat(dbPath).catch(() => null);
  if (!info?.isFile()) return emptyHistoryConversation();
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

function openCodeRole(message: string | null): string {
  if (!message) return "";
  try {
    const row = JSON.parse(message) as { role?: unknown };
    return typeof row.role === "string" ? row.role : "";
  } catch {
    return "";
  }
}

async function readOpenCodeSession(
  dbPath: string,
  sessionId: string,
): Promise<HistoryConversation> {
  const info = await stat(dbPath).catch(() => null);
  if (!info?.isFile()) return emptyHistoryConversation();
  const cacheKey = `${dbPath}\0${sessionId}\0${info.mtimeMs}:${info.size}`;
  const cached = textCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let inputs: Array<string | { data: string; role?: string | null }>;
    try {
      const joined = db
        .prepare(
          `SELECT part.data AS data, message.data AS message
           FROM part
           LEFT JOIN message ON message.id = part.message_id
           WHERE part.session_id = ?`,
        )
        .all(sessionId) as Array<{ data: string; message: string | null }>;
      inputs = joined.map((row) => ({ data: row.data, role: openCodeRole(row.message) }));
    } catch {
      const parts = db
        .prepare("SELECT data FROM part WHERE session_id = ?")
        .all(sessionId) as Array<{
        data: string;
      }>;
      inputs = parts.map((row) => row.data);
    }
    const text = conversationTextFromOpenCodeParts(inputs);
    textCache.set(cacheKey, text);
    return text;
  } finally {
    db.close();
  }
}
