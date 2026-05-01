import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface SettingsLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

interface CachedEntry {
  mtimeMs: number;
  env: Record<string, string>;
}

let cached: { filePath: string; entry: CachedEntry | null } | null = null;

function resolveSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "settings.json");
}

// Reads the user's `~/.claude/settings.json` `env` block.
//
// - Cached but invalidated on mtime change so edits made while the daemon is
//   running are picked up on the next call.
// - Non-string values (numbers, booleans, nested objects) are filtered out so
//   downstream code can safely treat values as strings.
// - Any IO/parse error is treated as "no settings" — callers should still work.
//   When `logger` is provided, parse failures are logged once per file mtime so
//   the same broken file doesn't spam the log on every call.
export function loadClaudeUserSettingsEnv(logger?: SettingsLogger): Record<string, string> {
  const filePath = resolveSettingsPath();

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    cached = { filePath, entry: null };
    return {};
  }

  if (cached && cached.filePath === filePath && cached.entry?.mtimeMs === mtimeMs) {
    return cached.entry.env;
  }

  let env: Record<string, string> = {};
  let parseError: unknown = null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const envField = (parsed as { env?: unknown }).env;
      if (envField && typeof envField === "object" && !Array.isArray(envField)) {
        env = filterStringValues(envField as Record<string, unknown>);
      }
    }
  } catch (err) {
    // Malformed settings.json — fall back to empty env.
    parseError = err;
    env = {};
  }

  if (parseError && logger) {
    logger.warn(
      {
        filePath,
        err: parseError instanceof Error ? parseError.message : String(parseError),
      },
      "Failed to parse Claude user settings.json — falling back to empty env",
    );
  }

  cached = { filePath, entry: { mtimeMs, env } };
  return env;
}

function filterStringValues(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// Test-only: clear the cached settings so tests that mutate fixture files start clean.
export function resetClaudeUserSettingsEnvCache(): void {
  cached = null;
}
