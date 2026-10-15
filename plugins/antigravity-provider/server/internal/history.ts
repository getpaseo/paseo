import { existsSync, readFileSync, readdirSync } from "node:fs";
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

interface ListSessionOptions {
  query?: string;
  cwd?: string;
  limit?: number;
}

function listFromSqlite(dbPath: string, options?: ListSessionOptions): ProviderSessionSummary[] {
  const DatabaseSyncClass = getDatabaseSync();
  if (!DatabaseSyncClass || !existsSync(dbPath)) return [];

  try {
    const db = new DatabaseSyncClass(dbPath, { readOnly: true });
    try {
      let sql =
        "SELECT conversation_id, title, created_at, updated_at, primary_workspace_path, preview FROM conversations";
      const params: (string | number)[] = [];
      const conditions: string[] = [];

      if (options?.cwd) {
        conditions.push("primary_workspace_path = ?");
        params.push(options.cwd);
      }
      if (options?.query) {
        conditions.push("(title LIKE ? OR preview LIKE ?)");
        params.push(`%${options.query}%`, `%${options.query}%`);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(" AND ")}`;
      }
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
        primary_workspace_path: string | null;
        preview: string | null;
      }>;

      return rows.map((row) => ({
        persistence: {
          version: 1,
          data: { conversationId: row.conversation_id },
        },
        cwd: row.primary_workspace_path || process.cwd(),
        title: row.title ?? undefined,
        description: row.preview ?? undefined,
        updatedAt: row.updated_at ?? row.created_at ?? undefined,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function matchesJsonlEntry(entry: Record<string, unknown>, options?: ListSessionOptions): boolean {
  if (
    options?.cwd &&
    entry.primary_workspace_path &&
    entry.primary_workspace_path !== options.cwd
  ) {
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
): ProviderSessionSummary[] {
  if (!existsSync(historyJsonl)) return [];

  try {
    const content = readFileSync(historyJsonl, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const results: ProviderSessionSummary[] = [];
    const seen = new Set<string>();

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;
        const convId = (entry.conversation_id || entry.id) as string | undefined;
        if (!convId || seen.has(convId) || !matchesJsonlEntry(entry, options)) continue;
        seen.add(convId);

        results.push({
          persistence: {
            version: 1,
            data: { conversationId: convId },
          },
          cwd: (entry.primary_workspace_path as string) || process.cwd(),
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
    return [];
  }
}

function listFromBrainDir(
  brainDir: string,
  options?: ListSessionOptions,
): ProviderSessionSummary[] {
  if (!existsSync(brainDir)) return [];

  try {
    const entries = readdirSync(brainDir, { withFileTypes: true });
    const results: ProviderSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      if (convId.startsWith(".")) continue;
      results.push({
        persistence: {
          version: 1,
          data: { conversationId: convId },
        },
        cwd: process.cwd(),
        title: `Session ${convId.slice(0, 8)}`,
      });
      if (options?.limit && results.length >= options.limit) break;
    }
    return results;
  } catch {
    return [];
  }
}

export function listAntigravitySessions(options?: ListSessionOptions): ProviderSessionSummary[] {
  const home = homedir();
  const dbPath = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
  const fromSqlite = listFromSqlite(dbPath, options);
  if (fromSqlite.length > 0) return fromSqlite;

  const historyJsonl = join(home, ".gemini", "antigravity-cli", "history.jsonl");
  const fromJsonl = listFromJsonl(historyJsonl, options);
  if (fromJsonl.length > 0) return fromJsonl;

  const brainDir = join(home, ".gemini", "antigravity-cli", "brain");
  return listFromBrainDir(brainDir, options);
}

export function getAntigravitySessionTitle(conversationId: string): string | null {
  const home = homedir();
  const dbPath = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
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
  return null;
}

export interface HistoryTurn {
  turnId: string;
  items: ProviderTimelineItem[];
  usage?: Required<Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">>;
}

function resolveTranscriptPath(conversationId: string): string | null {
  const home = homedir();
  const candidates = [
    join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    ),
    join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
    join(home, ".gemini", "antigravity-cli", "brain", conversationId, "transcript.jsonl"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
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
    const call = toolCalls[callIdx] as Record<string, unknown>;
    const callId = `hist-tool-${turnIndex}-${stepIdx}-${callIdx}`;
    const args = parseArgs(call.args ?? call.parameters);
    const toolName = (call.name as string) || "Antigravity tool";
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

export function readAntigravityTranscript(conversationId: string): HistoryTurn[] {
  const transcriptPath = resolveTranscriptPath(conversationId);
  if (!transcriptPath) return [];

  try {
    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const turns: HistoryTurn[] = [];

    let currentTurn: HistoryTurn | null = null;
    let turnIndex = 0;

    for (const line of lines) {
      let step: Record<string, unknown>;
      try {
        step = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = step.type;
      const stepIdx = typeof step.step_index === "number" ? step.step_index : 0;

      if (type === "USER_INPUT") {
        if (currentTurn && currentTurn.items.length > 0) turns.push(currentTurn);
        turnIndex++;
        currentTurn = {
          turnId: `hist-turn-${turnIndex}`,
          items: [
            {
              type: "user_message",
              id: `hist-msg-user-${turnIndex}`,
              clientMessageId: `hist-msg-user-${turnIndex}`,
              text: parseUserPromptText(step.content),
            },
          ],
        };
      } else if (type === "PLANNER_RESPONSE") {
        if (!currentTurn) {
          turnIndex++;
          currentTurn = { turnId: `hist-turn-${turnIndex}`, items: [] };
        }

        if (typeof step.thinking === "string") {
          currentTurn.items.push({
            type: "reasoning",
            id: `hist-thought-${turnIndex}-${stepIdx}`,
            text: step.thinking,
          });
        }

        if (Array.isArray(step.tool_calls)) {
          currentTurn.items.push(...buildToolCallItems(step.tool_calls, turnIndex, stepIdx));
        }

        if (typeof step.content === "string") {
          currentTurn.items.push({
            type: "assistant_message",
            id: `hist-msg-asst-${turnIndex}-${stepIdx}`,
            messageId: `hist-msg-asst-${turnIndex}-${stepIdx}`,
            text: step.content,
          });
        }

        currentTurn.usage = buildTurnUsage(
          currentTurn.usage,
          step.input_tokens,
          step.output_tokens,
          step.cache_read_tokens,
        );
      }
    }

    if (currentTurn && currentTurn.items.length > 0) turns.push(currentTurn);
    return turns;
  } catch {
    return [];
  }
}
