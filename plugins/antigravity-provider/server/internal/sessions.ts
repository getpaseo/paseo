import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  ProviderInput,
  ProviderLaunch,
  ProviderSessionSummary,
} from "@getpaseo/plugin/server/provider";

interface SqliteDatabase {
  prepare(sql: string): { all(...args: string[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
}

function builtinSqlite(): SqliteModule | undefined {
  const parsed = z
    .object({
      DatabaseSync: z.custom<SqliteModule["DatabaseSync"]>((value) => typeof value === "function"),
    })
    .safeParse(process.getBuiltinModule?.("node:sqlite"));
  return parsed.success ? parsed.data : undefined;
}

const DEFAULT_SESSION_LIMIT = 50;
const MAX_TITLE_LENGTH = 120;
const MAX_TRANSCRIPT_HEADER_BYTES = 64 * 1024;
const ANTIGRAVITY_ROOTS = ["antigravity-cli", "antigravity"] as const;

const workspaceUrisSchema = z.array(z.string());

const transcriptStepHeaderSchema = z.object({
  type: z.unknown().optional(),
  source: z.unknown().optional(),
  content: z.unknown().optional(),
});

interface RawSummaryRow {
  conversationId: string;
  title: string;
  preview: string;
  updatedAtRaw: unknown;
  workspaceUrisRaw: string;
}

interface SessionFilterContext {
  homeDir: string;
  inputCwd?: string;
  filterCwd: string | null;
  query: string | null;
}

export function listSessions(
  launch: ProviderLaunch,
  input: Extract<ProviderInput, { type: "sessions" }>,
): ProviderSessionSummary[] {
  const context: SessionFilterContext = {
    homeDir: launch.env.HOME || os.homedir(),
    inputCwd: input.cwd,
    filterCwd: input.cwd ? realpathOrResolve(input.cwd) : null,
    query: input.query?.trim().toLowerCase() || null,
  };
  const limit =
    typeof input.limit === "number" && input.limit > 0
      ? Math.floor(input.limit)
      : DEFAULT_SESSION_LIMIT;

  const seenConversationIds = new Set<string>();
  const candidates: Array<{
    row: RawSummaryRow;
    matchedCwd: string;
    updatedAt: string | undefined;
    sortTimeMs: number;
  }> = [];

  for (const root of ANTIGRAVITY_ROOTS) {
    const dbPath = path.join(context.homeDir, ".gemini", root, "conversation_summaries.db");
    if (!fs.existsSync(dbPath)) continue;

    for (const row of readSummaryRows(dbPath)) {
      if (seenConversationIds.has(row.conversationId)) continue;
      if (!isSafeConversationId(row.conversationId)) continue;
      const matchedCwd = matchWorkspaceCwd(
        row.workspaceUrisRaw,
        context.filterCwd,
        context.inputCwd,
      );
      if (!matchedCwd) continue;
      seenConversationIds.add(row.conversationId);
      const updatedAt = normalizeTimestamp(row.updatedAtRaw);
      candidates.push({
        row,
        matchedCwd,
        updatedAt,
        sortTimeMs: updatedAt ? Date.parse(updatedAt) : 0,
      });
    }
  }

  candidates.sort((left, right) => right.sortTimeMs - left.sortTimeMs);

  const summaries: ProviderSessionSummary[] = [];
  for (const candidate of candidates) {
    const summary = toSessionSummary(candidate, context);
    if (!summary) continue;
    summaries.push(summary);
    if (summaries.length >= limit) break;
  }
  return summaries;
}

function toSessionSummary(
  candidate: {
    row: RawSummaryRow;
    matchedCwd: string;
    updatedAt: string | undefined;
  },
  context: SessionFilterContext,
): ProviderSessionSummary | null {
  const { row, matchedCwd, updatedAt } = candidate;
  const { title, description, searchText } = resolveTitleAndDescription(row, context.homeDir);
  if (context.query && !matchesQuery(context.query, searchText, matchedCwd, row.conversationId)) {
    return null;
  }

  return {
    cwd: matchedCwd,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    persistence: {
      version: 1,
      data: { conversationId: row.conversationId },
    },
  };
}

function matchWorkspaceCwd(
  workspaceUrisRaw: string,
  filterCwd: string | null,
  inputCwd?: string,
): string | null {
  const workspaces = parseWorkspacePaths(workspaceUrisRaw);
  if (workspaces.length === 0) return null;
  if (filterCwd === null) return workspaces[0]!.raw;
  return workspaces.some((ws) => ws.resolved === filterCwd) ? (inputCwd ?? filterCwd) : null;
}

function resolveTitleAndDescription(
  row: RawSummaryRow,
  homeDir: string,
): { title: string; description?: string; searchText: string } {
  const rawTitle = collapseWhitespace(extractUserRequestText(row.title));
  const rawPreview = collapseWhitespace(extractUserRequestText(row.preview));
  const fallbackTitle =
    !rawTitle && !rawPreview ? readFirstTranscriptPrompt(homeDir, row.conversationId) : undefined;
  const fullTitle = rawTitle || rawPreview || fallbackTitle || "";
  const title = truncateTitle(fullTitle);
  const description =
    rawPreview && rawTitle && rawPreview !== rawTitle ? truncateTitle(rawPreview) : undefined;
  const searchText = [fullTitle, rawPreview].filter(Boolean).join("\n");
  return { title, description, searchText };
}

function matchesQuery(
  query: string,
  searchText: string,
  cwd: string,
  conversationId: string,
): boolean {
  const haystack = [searchText, cwd, conversationId].join("\n").toLowerCase();
  return haystack.includes(query);
}

function readSummaryRows(dbPath: string): RawSummaryRow[] {
  const sqlite = builtinSqlite();
  if (!sqlite) return [];
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = listMatchingSummaryTables(db);
    if (tables.has("conversation_summaries")) {
      return queryConversationSummariesTable(db);
    }
    if (tables.has("summaries")) {
      return queryLegacySummariesTable(db);
    }
    return [];
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close errors on read-only SQLite handles.
    }
  }
}

function listMatchingSummaryTables(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_summaries', 'summaries')",
    )
    .all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")).filter(Boolean));
}

function queryConversationSummariesTable(db: SqliteDatabase): RawSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT conversation_id, title, preview, last_modified_time, workspace_uris
       FROM conversation_summaries
       WHERE parent_conversation_id = '' AND nesting_depth = 0 AND step_count > 0
       ORDER BY last_modified_time DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    if (typeof row.conversation_id !== "string" || typeof row.workspace_uris !== "string") {
      return [];
    }
    return [
      {
        conversationId: row.conversation_id,
        title: typeof row.title === "string" ? row.title : "",
        preview: typeof row.preview === "string" ? row.preview : "",
        updatedAtRaw: row.last_modified_time,
        workspaceUrisRaw: row.workspace_uris,
      },
    ];
  });
}

function queryLegacySummariesTable(db: SqliteDatabase): RawSummaryRow[] {
  const rows = db
    .prepare(
      `SELECT conversation_id, title, workspace_uris, updated_at
       FROM summaries
       ORDER BY updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    if (typeof row.conversation_id !== "string" || typeof row.workspace_uris !== "string") {
      return [];
    }
    return [
      {
        conversationId: row.conversation_id,
        title: typeof row.title === "string" ? row.title : "",
        preview: "",
        updatedAtRaw: row.updated_at,
        workspaceUrisRaw: row.workspace_uris,
      },
    ];
  });
}

function parseWorkspacePaths(workspaceUrisRaw: string): Array<{ raw: string; resolved: string }> {
  try {
    const parsed = workspaceUrisSchema.safeParse(JSON.parse(workspaceUrisRaw));
    if (!parsed.success) return [];
    const results: Array<{ raw: string; resolved: string }> = [];
    for (const entry of parsed.data) {
      const fsPath = uriOrPathToFsPath(entry);
      if (!fsPath) continue;
      results.push({ raw: fsPath, resolved: realpathOrResolve(fsPath) });
    }
    return results;
  } catch {
    return [];
  }
}

function uriOrPathToFsPath(uriOrPath: string): string | null {
  const trimmed = uriOrPath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(trimmed) ? trimmed : null;
}

function realpathOrResolve(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isSafeConversationId(conversationId: string): boolean {
  return (
    Boolean(conversationId) &&
    conversationId !== "." &&
    conversationId !== ".." &&
    path.basename(conversationId) === conversationId &&
    !conversationId.includes("/") &&
    !conversationId.includes("\\")
  );
}

export function extractUserRequestText(rawContent: string): string {
  const match = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match && match[1] !== undefined) {
    return match[1].trim();
  }
  return rawContent
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string): string {
  if (value.length <= MAX_TITLE_LENGTH) return value;
  return `${value.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function normalizeTimestamp(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("0001-01-01")) return undefined;
  const isoCandidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = new Date(isoCandidate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function readFirstTranscriptPrompt(homeDir: string, conversationId: string): string | undefined {
  for (const candidate of candidateTranscriptPaths(homeDir, conversationId)) {
    const prompt = extractFirstPromptFromFile(candidate);
    if (prompt) return prompt;
  }
  return undefined;
}

function candidateTranscriptPaths(homeDir: string, conversationId: string): string[] {
  const files = ["transcript.jsonl", "transcript_full.jsonl"] as const;
  const paths: string[] = [];
  for (const root of ANTIGRAVITY_ROOTS) {
    for (const file of files) {
      const candidate = path.join(
        homeDir,
        ".gemini",
        root,
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        file,
      );
      if (fs.existsSync(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

function extractFirstPromptFromFile(filePath: string): string | undefined {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_HEADER_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_TRANSCRIPT_HEADER_BYTES, 0);
    if (bytesRead <= 0) return undefined;
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = chunk.split("\n");
    if (bytesRead === MAX_TRANSCRIPT_HEADER_BYTES && lines.length > 1) {
      lines.pop();
    }
    for (const line of lines) {
      const prompt = parseExplicitUserInputLine(line);
      if (prompt) return prompt;
    }
  } catch {
    // Ignore unreadable transcript files during session listing.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors on read-only transcript handles.
      }
    }
  }
  return undefined;
}

function parseExplicitUserInputLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = transcriptStepHeaderSchema.safeParse(JSON.parse(line));
    if (!parsed.success) return undefined;
    if (
      parsed.data.type !== "USER_INPUT" ||
      parsed.data.source !== "USER_EXPLICIT" ||
      typeof parsed.data.content !== "string"
    ) {
      return undefined;
    }
    const cleaned = collapseWhitespace(extractUserRequestText(parsed.data.content));
    return cleaned || undefined;
  } catch {
    return undefined;
  }
}
