import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import type { ACPContextUsageResolver, AvailableACPModel } from "./acp-agent.js";

const CURSOR_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CURSOR_SQLITE_TIMEOUT_MS = 2_000;
const CURSOR_SQLITE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const CURSOR_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_CONTEXT_PARAMETER_PATTERN = /context=(\d+(?:\.\d+)?)([km]?)(?:[,\]])/i;

const CURSOR_MESSAGES_QUERY = `
WITH latest_summary AS (
  SELECT max(rowid) AS rowid
  FROM blobs
  WHERE json_valid(CAST(data AS TEXT)) = 1
    AND json_extract(CAST(data AS TEXT), '$.providerOptions.cursor.isSummary') = 1
)
-- Cursor stores tool metadata alongside message content. Returning the full
-- JSON makes large, active sessions exceed the bounded SQLite read budget.
SELECT json_extract(CAST(data AS TEXT), '$.content') AS message
FROM blobs
WHERE json_valid(CAST(data AS TEXT)) = 1
  AND json_type(CAST(data AS TEXT), '$.role') = 'text'
  -- Cursor replaces earlier transcript turns with this summary. Older rows
  -- remain in SQLite for history, but are no longer part of the live context.
  AND rowid >= COALESCE((SELECT rowid FROM latest_summary), 0)
ORDER BY rowid
`;

interface CursorContextUsageResolverOptions {
  env?: Record<string, string>;
  readSessionMessages?: (sessionId: string) => string[];
  resolveContextWindowMaxTokens?: (modelId: string | null) => number | undefined;
}

function parsePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseParameterizedContextWindow(modelId: string | null): number | null {
  if (!modelId) {
    return null;
  }
  const match = CURSOR_CONTEXT_PARAMETER_PATTERN.exec(modelId);
  if (!match?.[1]) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2]?.toLowerCase();
  let multiplier = 1;
  if (unit === "m") {
    multiplier = 1_000_000;
  } else if (unit === "k") {
    multiplier = 1_000;
  }
  return Math.round(amount * multiplier);
}

export function resolveCursorContextWindowMaxTokens(
  modelId: string | null,
  metadata?: Record<string, unknown> | null,
): number {
  return (
    parsePositiveNumber(metadata?.["totalContextTokens"]) ??
    parsePositiveNumber(metadata?.["contextWindowMaxTokens"]) ??
    parseParameterizedContextWindow(modelId) ??
    CURSOR_DEFAULT_CONTEXT_WINDOW_TOKENS
  );
}

export function transformCursorModelDefinition(
  model: AvailableACPModel,
  definition: AgentModelDefinition,
): AgentModelDefinition {
  return {
    ...definition,
    contextWindowMaxTokens: resolveCursorContextWindowMaxTokens(model.modelId, model._meta),
  };
}

export function estimateCursorContextTokens(messages: readonly string[]): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;

  for (const message of messages) {
    for (const character of message) {
      if (character.charCodeAt(0) <= 0x7f) {
        asciiCharacters += 1;
      } else {
        nonAsciiCharacters += 1;
      }
    }
  }

  return Math.ceil(asciiCharacters / 4) + nonAsciiCharacters + messages.length * 4;
}

function createCursorSessionMessageReader(
  env: Record<string, string> | undefined,
): (sessionId: string) => string[] {
  const home = env?.["HOME"] || process.env["HOME"] || homedir();
  return (sessionId) => {
    if (!CURSOR_SESSION_ID_PATTERN.test(sessionId)) {
      return [];
    }

    const databasePath = join(home, ".cursor", "acp-sessions", sessionId, "store.db");
    if (!existsSync(databasePath)) {
      return [];
    }

    const stdout = execFileSync(
      "sqlite3",
      ["-readonly", "-json", databasePath, CURSOR_MESSAGES_QUERY],
      {
        encoding: "utf8",
        timeout: CURSOR_SQLITE_TIMEOUT_MS,
        maxBuffer: CURSOR_SQLITE_MAX_BUFFER_BYTES,
        env: { ...process.env, ...env },
      },
    );
    if (!stdout.trim()) {
      return [];
    }

    const rows = JSON.parse(stdout) as Array<{ message?: unknown }>;
    return rows.flatMap((row) => (typeof row.message === "string" ? [row.message] : []));
  };
}

export function createCursorContextUsageResolver(
  options: CursorContextUsageResolverOptions = {},
): ACPContextUsageResolver {
  const readSessionMessages =
    options.readSessionMessages ?? createCursorSessionMessageReader(options.env);

  return ({ sessionId, modelId, usage }) => {
    if (
      usage?.contextWindowEstimated !== true &&
      usage?.contextWindowMaxTokens !== undefined &&
      usage.contextWindowUsedTokens !== undefined
    ) {
      return usage;
    }

    try {
      const messages = readSessionMessages(sessionId);
      if (messages.length === 0) {
        return usage;
      }
      const contextWindowMaxTokens =
        options.resolveContextWindowMaxTokens?.(modelId) ??
        resolveCursorContextWindowMaxTokens(modelId);
      return {
        ...usage,
        contextWindowMaxTokens,
        contextWindowUsedTokens: Math.min(
          estimateCursorContextTokens(messages),
          contextWindowMaxTokens,
        ),
        contextWindowEstimated: true,
      };
    } catch {
      return usage;
    }
  };
}
