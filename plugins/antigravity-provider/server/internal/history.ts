import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderSessionSummary,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { mapHistoryToolDetail } from "./timeline.js";

interface SqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

type SqliteDatabaseConstructor = new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

function getDatabaseSync(): SqliteDatabaseConstructor | null {
  try {
    // Dynamic require so environments without node:sqlite do not fail module evaluation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite") as { DatabaseSync?: SqliteDatabaseConstructor };
    return sqlite.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

export function resolveAntigravityRoot(
  baseDir?: string,
  env?: Record<string, string | undefined>,
): string {
  if (baseDir) return baseDir;
  if (env?.AGY_HOME) return env.AGY_HOME;
  const envHome = env?.HOME || (process.platform === "win32" ? env?.USERPROFILE : undefined);
  if (envHome) return join(envHome, ".gemini", "antigravity-cli");
  if (process.env.AGY_HOME) return process.env.AGY_HOME;
  const processHome =
    process.env.HOME ||
    (process.platform === "win32" ? process.env.USERPROFILE : undefined) ||
    homedir();
  return join(processHome, ".gemini", "antigravity-cli");
}

export interface ListSessionOptions {
  query?: string;
  cwd?: string;
  limit?: number;
  env?: Record<string, string | undefined>;
}

function parseWorkspaceUri(uri: string): string | null {
  if (typeof uri !== "string" || !uri) return null;
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
      if (/^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1);
      }
      return p;
    }
  }
  return uri;
}

function parseWorkspaceUris(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const list: unknown = JSON.parse(raw);
    if (Array.isArray(list)) {
      return findFirstWorkspaceUri(list);
    }
  } catch {}
  return parseWorkspaceUri(raw);
}

function findFirstWorkspaceUri(list: unknown[]): string | null {
  for (const item of list) {
    if (typeof item === "string" && item.trim()) {
      const parsed = parseWorkspaceUri(item.trim());
      if (parsed) return parsed;
    }
  }
  return null;
}

export function normalizePath(p?: string | null): string {
  if (!p) return "";
  let resolved = p;
  try {
    if (existsSync(p)) {
      resolved = realpathSync.native(p);
    }
  } catch {}
  const standardized = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(resolved)) {
    return standardized.toLowerCase();
  }
  return standardized;
}

function parseIsoTimestamp(t?: unknown): number {
  if (typeof t === "number") return t;
  if (!t || typeof t !== "string" || t.startsWith("000")) return 0;
  const ms = Date.parse(t.replace(" ", "T"));
  return Number.isNaN(ms) ? 0 : ms;
}

interface SqliteRow {
  conversation_id: string;
  title: string | null;
  last_modified_time: string | null;
  last_user_input_time: string | null;
  preview: string | null;
  workspace_uris: string | null;
}

function rowToCandidate(
  row: SqliteRow,
  normalizedCwd: string | null,
): { summary: ProviderSessionSummary; time: number } | null {
  const workspacePath = parseWorkspaceUris(row.workspace_uris);
  if (!workspacePath) return null;

  if (normalizedCwd && normalizePath(workspacePath) !== normalizedCwd) {
    return null;
  }

  const title = (row.title && row.title.trim()) || (row.preview && row.preview.trim()) || undefined;
  const inputTime = parseIsoTimestamp(row.last_user_input_time);
  const modTime = parseIsoTimestamp(row.last_modified_time);
  const effectiveTime = Math.max(inputTime, modTime);
  const updatedAt = effectiveTime > 0 ? new Date(effectiveTime).toISOString() : undefined;

  return {
    summary: {
      persistence: {
        version: 1,
        data: { conversationId: row.conversation_id },
      },
      cwd: workspacePath,
      title,
      description: row.preview ?? undefined,
      updatedAt,
    },
    time: effectiveTime,
  };
}

function listFromSqlite(
  dbPath: string,
  options?: ListSessionOptions,
): ProviderSessionSummary[] | null {
  const DatabaseSyncClass = getDatabaseSync();
  if (!DatabaseSyncClass || !existsSync(dbPath)) return null;

  try {
    const db = new DatabaseSyncClass(dbPath, { readOnly: true });
    try {
      const tableCheck = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
        )
        .get();
      const hasSummariesTable = Boolean(tableCheck);

      let sql = hasSummariesTable
        ? "SELECT conversation_id, title, preview, last_modified_time, last_user_input_time, workspace_uris FROM conversation_summaries"
        : "SELECT conversation_id, title, preview, updated_at AS last_modified_time, created_at AS last_user_input_time, primary_workspace_path AS workspace_uris FROM conversations";

      const params: (string | number)[] = [];
      const conditions: string[] = [];

      if (options?.query) {
        conditions.push("(title LIKE ? OR preview LIKE ?)");
        params.push(`%${options.query}%`, `%${options.query}%`);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as SqliteRow[];

      const normalizedCwd = normalizePath(options?.cwd);
      const candidates: Array<{
        summary: ProviderSessionSummary;
        time: number;
      }> = [];

      for (const row of rows) {
        const candidate = rowToCandidate(row, normalizedCwd);
        if (candidate) {
          candidates.push(candidate);
        }
      }

      candidates.sort((a, b) => b.time - a.time);
      const results = candidates.map((c) => c.summary);
      if (options?.limit && options.limit > 0) {
        return results.slice(0, options.limit);
      }
      return results;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function matchesJsonlEntry(entry: Record<string, unknown>, options?: ListSessionOptions): boolean {
  const rawWorkspace =
    (typeof entry.primary_workspace_path === "string" && entry.primary_workspace_path) ||
    (typeof entry.workspace === "string" && entry.workspace) ||
    null;
  if (!rawWorkspace) {
    return false;
  }
  if (options?.cwd && normalizePath(rawWorkspace) !== normalizePath(options.cwd)) {
    return false;
  }
  const title =
    (typeof entry.title === "string" && entry.title) ||
    (typeof entry.display === "string" && entry.display) ||
    "";
  if (options?.query && !title.includes(options.query)) {
    return false;
  }
  return true;
}

function parseJsonlUpdatedAt(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.updated_at === "string") return entry.updated_at;
  if (typeof entry.timestamp === "number") return new Date(entry.timestamp).toISOString();
  if (typeof entry.timestamp === "string") return entry.timestamp;
  return undefined;
}

function parseJsonlSession(
  line: string,
  options?: ListSessionOptions,
): { summary: ProviderSessionSummary; conversationId: string } | null {
  try {
    const raw = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const convId = (entry.conversation_id || entry.id || entry.conversationId) as
      | string
      | undefined;
    if (!convId || !matchesJsonlEntry(entry, options)) return null;

    const workspacePath = (entry.primary_workspace_path as string) || (entry.workspace as string);
    const title = (entry.title as string) || (entry.display as string) || undefined;
    const updatedAt = parseJsonlUpdatedAt(entry);

    return {
      conversationId: convId,
      summary: {
        persistence: {
          version: 1,
          data: { conversationId: convId },
        },
        cwd: workspacePath,
        title,
        description: (entry.preview as string) ?? undefined,
        updatedAt,
      },
    };
  } catch {
    return null;
  }
}

function listFromJsonl(
  historyJsonl: string,
  options?: ListSessionOptions,
): ProviderSessionSummary[] | null {
  if (!existsSync(historyJsonl)) return null;

  try {
    const content = readFileSync(historyJsonl, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const results: ProviderSessionSummary[] = [];
    const seen = new Set<string>();

    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseJsonlSession(lines[i], options);
      if (!parsed) continue;
      if (seen.has(parsed.conversationId)) continue;
      seen.add(parsed.conversationId);
      results.push(parsed.summary);

      if (options?.limit && results.length >= options.limit) break;
    }
    return results;
  } catch {
    return null;
  }
}

export function listAntigravitySessions(
  options?: ListSessionOptions,
  baseDir?: string,
  env?: Record<string, string | undefined>,
): ProviderSessionSummary[] {
  const root = resolveAntigravityRoot(baseDir, options?.env ?? env);
  const dbPath = join(root, "conversation_summaries.db");

  const fromSqlite = listFromSqlite(dbPath, options);
  if (fromSqlite !== null) return fromSqlite;

  const historyJsonl = join(root, "history.jsonl");
  const fromJsonl = listFromJsonl(historyJsonl, options);
  if (fromJsonl !== null) return fromJsonl;

  return [];
}

function extractJsonlTitle(line: string, conversationId: string): string | null {
  try {
    const raw = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const convId = (entry.conversation_id || entry.id || entry.conversationId) as
      | string
      | undefined;
    if (convId !== conversationId) return null;
    const title = (entry.title as string) || (entry.display as string);
    if (title && title.trim()) return title.trim();
  } catch {
    // ignore
  }
  return null;
}

function getTitleFromJsonl(historyJsonl: string, conversationId: string): string | null {
  if (!existsSync(historyJsonl)) return null;
  try {
    const content = readFileSync(historyJsonl, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const found = extractJsonlTitle(lines[i], conversationId);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

export function getAntigravitySessionTitle(
  conversationId: string,
  baseDir?: string,
  env?: Record<string, string | undefined>,
): string | null {
  const root = resolveAntigravityRoot(baseDir, env);
  const dbPath = join(root, "conversation_summaries.db");
  const DatabaseSyncClass = getDatabaseSync();

  if (DatabaseSyncClass && existsSync(dbPath)) {
    try {
      const db = new DatabaseSyncClass(dbPath, { readOnly: true });
      try {
        const tableCheck = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
          )
          .get();
        const hasSummariesTable = Boolean(tableCheck);

        const sql = hasSummariesTable
          ? "SELECT title, preview FROM conversation_summaries WHERE conversation_id = ? LIMIT 1"
          : "SELECT title, preview FROM conversations WHERE conversation_id = ? LIMIT 1";

        const stmt = db.prepare(sql);
        const row = stmt.get(conversationId) as
          | { title: string | null; preview?: string | null }
          | undefined;
        const foundTitle = (row?.title && row.title.trim()) || (row?.preview && row.preview.trim());
        if (foundTitle) return foundTitle;
      } finally {
        db.close();
      }
    } catch {
      // ignore
    }
  }

  const historyJsonl = join(root, "history.jsonl");
  return getTitleFromJsonl(historyJsonl, conversationId);
}

export interface HistoryTurn {
  turnId: string;
  items: ProviderTimelineItem[];
  usage?: Required<Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">>;
}

function resolveTranscriptPath(
  conversationId: string,
  baseDir?: string,
  env?: Record<string, string | undefined>,
): string | null {
  const root = resolveAntigravityRoot(baseDir, env);
  const candidates = [
    join(root, "brain", conversationId, ".system_generated", "logs", "transcript_full.jsonl"),
    join(root, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
    join(root, "brain", conversationId, "transcript.jsonl"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return { raw };
    } catch {
      return { raw };
    }
  }
  if (typeof raw === "object" && raw !== null) {
    const unquoted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (
        typeof v === "string" &&
        ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("{") && v.endsWith("}")))
      ) {
        try {
          unquoted[k] = JSON.parse(v);
        } catch {
          unquoted[k] = v;
        }
      } else {
        unquoted[k] = v;
      }
    }
    return unquoted;
  }
  return {};
}

function parseUserPromptText(content: unknown): string {
  if (typeof content !== "string") return "";
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  return match ? match[1].trim() : content;
}

function buildToolCallItems(
  toolCalls: unknown[],
  turnIndex: number,
  stepIdx: number,
): ProviderTimelineItem[] {
  const items: ProviderTimelineItem[] = [];
  for (let callIdx = 0; callIdx < toolCalls.length; callIdx++) {
    const rawCall = toolCalls[callIdx];
    if (typeof rawCall !== "object" || rawCall === null) continue;
    const call = rawCall as Record<string, unknown>;
    const callId = `hist-tool-${turnIndex}-${stepIdx}-${callIdx}`;
    const args = parseArgs(call.args ?? call.parameters);
    const toolName = typeof call.name === "string" ? call.name : "Antigravity tool";
    const detail = mapHistoryToolDetail(toolName, args);

    items.push({
      type: "tool_call",
      id: callId,
      callId,
      name: toolName,
      detail,
      status: "completed",
      error: null,
    });
  }
  return items;
}

function buildTurnUsage(
  prev: HistoryTurn["usage"],
  inputTokens?: unknown,
  outputTokens?: unknown,
  cacheTokens?: unknown,
): HistoryTurn["usage"] {
  const inTok = typeof inputTokens === "number" ? inputTokens : 0;
  const outTok = typeof outputTokens === "number" ? outputTokens : 0;
  const cacheTok = typeof cacheTokens === "number" ? cacheTokens : 0;
  if (!inTok && !outTok) return prev;

  return {
    inputTokens: (prev?.inputTokens ?? 0) + inTok,
    outputTokens: (prev?.outputTokens ?? 0) + outTok,
    cachedInputTokens: (prev?.cachedInputTokens ?? 0) + cacheTok,
  };
}

interface TranscriptParserState {
  currentTurn: HistoryTurn | null;
  turnIndex: number;
  turns: HistoryTurn[];
}

function handleUserInput(step: Record<string, unknown>, state: TranscriptParserState): void {
  if (state.currentTurn && state.currentTurn.items.length > 0) {
    state.turns.push(state.currentTurn);
  }
  state.turnIndex++;
  state.currentTurn = {
    turnId: `hist-turn-${state.turnIndex}`,
    items: [
      {
        type: "user_message",
        id: `hist-msg-user-${state.turnIndex}`,
        clientMessageId: `hist-msg-user-${state.turnIndex}`,
        text: parseUserPromptText(step.content),
      },
    ],
  };
}

function handlePlannerResponse(step: Record<string, unknown>, state: TranscriptParserState): void {
  if (!state.currentTurn) {
    state.turnIndex++;
    state.currentTurn = { turnId: `hist-turn-${state.turnIndex}`, items: [] };
  }
  const turn = state.currentTurn;
  const turnIndex = state.turnIndex;
  const stepIdx = typeof step.step_index === "number" ? step.step_index : 0;

  if (typeof step.thinking === "string") {
    turn.items.push({
      type: "reasoning",
      id: `hist-thought-${turnIndex}-${stepIdx}`,
      text: step.thinking,
    });
  }

  if (Array.isArray(step.tool_calls)) {
    turn.items.push(...buildToolCallItems(step.tool_calls, turnIndex, stepIdx));
  }

  if (typeof step.content === "string") {
    turn.items.push({
      type: "assistant_message",
      id: `hist-msg-asst-${turnIndex}-${stepIdx}`,
      messageId: `hist-msg-asst-${turnIndex}-${stepIdx}`,
      text: step.content,
    });
  }

  turn.usage = buildTurnUsage(
    turn.usage,
    step.input_tokens,
    step.output_tokens,
    step.cache_read_tokens,
  );
}

function processTranscriptLine(line: string, state: TranscriptParserState): void {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return;
    const step = parsed as Record<string, unknown>;

    if (step.type === "USER_INPUT") {
      handleUserInput(step, state);
    } else if (step.type === "PLANNER_RESPONSE") {
      handlePlannerResponse(step, state);
    }
  } catch {
    // Ignore single malformed line without erasing valid turns
  }
}

export function readAntigravityTranscript(
  conversationId: string,
  baseDir?: string,
  env?: Record<string, string | undefined>,
): HistoryTurn[] {
  const transcriptPath = resolveTranscriptPath(conversationId, baseDir, env);
  if (!transcriptPath) return [];

  const state: TranscriptParserState = {
    currentTurn: null,
    turnIndex: 0,
    turns: [],
  };

  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      processTranscriptLine(line, state);
    }

    if (state.currentTurn && state.currentTurn.items.length > 0) {
      state.turns.push(state.currentTurn);
    }
  } catch {
    // Preserve any turns parsed before reading failure
  }
  return state.turns;
}
