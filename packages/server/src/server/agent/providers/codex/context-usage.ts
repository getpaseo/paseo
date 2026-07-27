import { type Dirent, promises as fs } from "node:fs";
import { join } from "node:path";

// Codex records `token_count` events into its per-session rollout `.jsonl`, which
// carries `model_context_window` and the per-turn token totals. The app-server's
// `thread/tokenUsage/updated` notification is unreliable (absent on some CLI
// versions), so this rollout file is the authoritative fallback for the context
// window meter — the Codex analog of Grok's `signals.json`.

const CODEX_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// token_count lines are small and frequent, so a bounded tail read finds the most
// recent one without loading rollout files that can grow to hundreds of megabytes.
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

// sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<sessionId>.jsonl
const ROLLOUT_SEARCH_DEPTH = 4;

export interface CodexContextUsageSignals {
  contextWindowMaxTokens: number;
  contextWindowUsedTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Extract context-window usage from a Codex `token_count` `info` block. The
 * rollout file and the app-server notification share this shape, so this is the
 * single place that understands `model_context_window` + `last_token_usage`.
 */
export function extractCodexContextUsageFromInfo(info: unknown): CodexContextUsageSignals | null {
  if (!isRecord(info)) return null;
  const contextWindowMaxTokens =
    positiveNumber(info.model_context_window) ?? positiveNumber(info.modelContextWindow);
  let last: Record<string, unknown> | null = null;
  if (isRecord(info.last_token_usage)) {
    last = info.last_token_usage;
  } else if (isRecord(info.last)) {
    last = info.last;
  }
  const contextWindowUsedTokens = last
    ? (nonNegativeNumber(last.total_tokens) ?? nonNegativeNumber(last.totalTokens))
    : null;
  if (contextWindowMaxTokens === null || contextWindowUsedTokens === null) return null;
  return { contextWindowMaxTokens, contextWindowUsedTokens };
}

function extractTokenCountInfo(entry: unknown): unknown {
  if (!isRecord(entry)) return null;
  const payload = isRecord(entry.payload) ? entry.payload : null;
  if (!payload || payload.type !== "token_count") return null;
  return payload.info ?? null;
}

async function walkForSuffix(dir: string, suffix: string, depth: number): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Rollout date folders sort lexically, so scan newest-first to reach an active
  // session's file quickly.
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name.endsWith(suffix)) return join(dir, entry.name);
    } else if (entry.isDirectory() && depth > 0) {
      subdirs.push(join(dir, entry.name));
    }
  }
  for (const subdir of subdirs) {
    const found = await walkForSuffix(subdir, suffix, depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * Locate the rollout `.jsonl` for a Codex session. This walks the dated
 * `sessions/` tree, so callers should cache the result per session rather than
 * resolving it on every turn.
 */
export async function resolveCodexRolloutFile(
  codexHome: string,
  sessionId: string,
): Promise<string | null> {
  if (!CODEX_SESSION_ID_PATTERN.test(sessionId)) return null;
  return walkForSuffix(join(codexHome, "sessions"), `-${sessionId}.jsonl`, ROLLOUT_SEARCH_DEPTH);
}

/**
 * Read the most recent context-window usage from a known rollout file by
 * scanning only a bounded tail (rollout files can reach hundreds of MB).
 */
export async function readCodexContextUsageFromRollout(
  filePath: string,
): Promise<CodexContextUsageSignals | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const { size } = await handle.stat();
    const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
    const length = size - start;
    if (length <= 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) {
      // Drop the leading partial line left by reading from the middle of a line.
      const newlineIndex = text.indexOf("\n");
      text = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : "";
    }
    // Scan newest-first; a token_count is emitted every turn so it sits near EOF.
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const signals = extractCodexContextUsageFromInfo(extractTokenCountInfo(parsed));
      if (signals) return signals;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
