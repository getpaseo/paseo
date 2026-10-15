import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

function resolveAntigravityRoot(baseDir?: string): string {
  return baseDir ?? process.env.AGY_HOME ?? join(homedir(), ".gemini", "antigravity-cli");
}

export interface ListSessionOptions {
  query?: string;
  cwd?: string;
  limit?: number;
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
      let sql =
        "SELECT conversation_id, title, created_at, updated_at, primary_workspace_path, preview FROM conversations";
      const params: (string | number)[] = [];
      const conditions: string[] = [
        "primary_workspace_path IS NOT NULL AND primary_workspace_path != ''",
      ];

      if (options?.cwd) {
        conditions.push("primary_workspace_path = ?");
        params.push(options.cwd);
      }
      if (options?.query) {
        conditions.push("(title LIKE ? OR preview LIKE ?)");
        params.push(`%${options.query}%`, `%${options.query}%`);
      }
      sql += ` WHERE ${conditions.join(" AND ")}`;
      sql += " ORDER BY updated_at DESC";
      if (options?.limit && options.limit > 0) {
        sql += " LIMIT ?";
        params.push(options.limit);
      }

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as Array<{
        conversation_id: string;
        title: string | null;
        created_at: string | null;
        updated_at: string | null;
        primary_workspace_path: string;
        preview: string | null;
      }>;

      return rows.map((row) => ({
        persistence: {
          version: 1,
          data: { conversationId: row.conversation_id },
        },
        cwd: row.primary_workspace_path,
        title: row.title ?? undefined,
        description: row.preview ?? undefined,
        updatedAt: row.updated_at ?? row.created_at ?? undefined,
      }));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function matchesJsonlEntry(entry: Record<string, unknown>, options?: ListSessionOptions): boolean {
  if (
    typeof entry.primary_workspace_path !== "string" ||
    entry.primary_workspace_path.length === 0
  ) {
    return false;
  }
  if (options?.cwd && entry.primary_workspace_path !== options.cwd) {
    return false;
  }
  if (options?.query && typeof entry.title === "string" && !entry.title.includes(options.query)) {
    return false;
  }
  return true;
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
      try {
        const raw = JSON.parse(lines[i]);
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        const convId = (entry.conversation_id || entry.id) as string | undefined;
        if (!convId || seen.has(convId) || !matchesJsonlEntry(entry, options)) continue;
        seen.add(convId);

        results.push({
          persistence: {
            version: 1,
            data: { conversationId: convId },
          },
          cwd: entry.primary_workspace_path as string,
          title: (entry.title as string) ?? undefined,
          description: (entry.preview as string) ?? undefined,
          updatedAt: (entry.updated_at as string) ?? (entry.timestamp as string) ?? undefined,
        });

        if (options?.limit && results.length >= options.limit) break;
      } catch {
        // ignore malformed line
      }
    }
    return results;
  } catch {
    return null;
  }
}

export function listAntigravitySessions(
  options?: ListSessionOptions,
  baseDir?: string,
): ProviderSessionSummary[] {
  const root = resolveAntigravityRoot(baseDir);
  const dbPath = join(root, "conversation_summaries.db");

  const fromSqlite = listFromSqlite(dbPath, options);
  if (fromSqlite !== null) return fromSqlite;

  const historyJsonl = join(root, "history.jsonl");
  const fromJsonl = listFromJsonl(historyJsonl, options);
  if (fromJsonl !== null) return fromJsonl;

  return [];
}

function getTitleFromJsonl(historyJsonl: string, conversationId: string): string | null {
  if (!existsSync(historyJsonl)) return null;
  try {
    const content = readFileSync(historyJsonl, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const raw = JSON.parse(lines[i]);
        if (typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        const convId = (entry.conversation_id || entry.id) as string | undefined;
        if (convId === conversationId && typeof entry.title === "string" && entry.title) {
          return entry.title;
        }
      } catch {
        // ignore
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function getAntigravitySessionTitle(
  conversationId: string,
  baseDir?: string,
): string | null {
  const root = resolveAntigravityRoot(baseDir);
  const dbPath = join(root, "conversation_summaries.db");
  const DatabaseSyncClass = getDatabaseSync();

  if (DatabaseSyncClass && existsSync(dbPath)) {
    try {
      const db = new DatabaseSyncClass(dbPath, { readOnly: true });
      try {
        const stmt = db.prepare(
          "SELECT title FROM conversations WHERE conversation_id = ? LIMIT 1",
        );
        const row = stmt.get(conversationId) as { title: string | null } | undefined;
        if (row?.title) return row.title;
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

function resolveTranscriptPath(conversationId: string, baseDir?: string): string | null {
  const root = resolveAntigravityRoot(baseDir);
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

export function readAntigravityTranscript(conversationId: string, baseDir?: string): HistoryTurn[] {
  const transcriptPath = resolveTranscriptPath(conversationId, baseDir);
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
