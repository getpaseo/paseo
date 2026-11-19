import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import { normalizeClaudeRuntimeModelId } from "./model-manifest.js";

// Claude Code accepts auto-compact windows from 100k to 1M tokens and ignores settings outside it.
const MIN_AUTO_COMPACT_WINDOW = 100_000;
const MAX_AUTO_COMPACT_WINDOW = 1_000_000;
const AUTO_COMPACT_WINDOW_ENV_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const ENV_WINDOW_SUFFIX_MULTIPLIERS = new Map([
  ["k", 1_000],
  ["m", 1_000_000],
]);

type ConfiguredAutoCompactWindow = number | "auto";

/** The auto-compact windows Claude Code resolves from its settings files and environment. */
export interface ClaudeAutoCompactWindows {
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW, which takes precedence over every setting. */
  envWindow: number | undefined;
  /** The top-level `autoCompactWindow` setting. */
  defaultWindow: number | undefined;
  /** `modelSettings[model].autoCompactWindow`, keyed by canonical model name. */
  byModel: Map<string, ConfiguredAutoCompactWindow>;
}

export interface ReadClaudeAutoCompactWindowsOptions {
  configDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;
}

/**
 * Reads the user, project and local settings the SDK session loads (lowest precedence first) and
 * merges their auto-compact windows the way Claude Code does. Managed policy settings are not read.
 */
export async function readClaudeAutoCompactWindows(
  options: ReadClaudeAutoCompactWindowsOptions,
): Promise<ClaudeAutoCompactWindows> {
  const settingsPaths = [
    path.join(options.configDir, "settings.json"),
    path.join(options.cwd, ".claude", "settings.json"),
    path.join(options.cwd, ".claude", "settings.local.json"),
  ];
  let envValue = options.env[AUTO_COMPACT_WINDOW_ENV_KEY];
  let defaultWindow: number | undefined;
  let byModel = new Map<string, ConfiguredAutoCompactWindow>();

  for (const settingsPath of settingsPaths) {
    const settings = await readSettingsFile(settingsPath, options.logger);
    if (!settings) {
      continue;
    }
    const fileWindows = readModelWindows(settings.modelSettings);
    const fileDefaultWindow = parseSettingsWindow(settings.autoCompactWindow);
    // A file that sets the top-level window drops per-model windows from lower-precedence files.
    if (fileDefaultWindow === undefined) {
      byModel = new Map([...byModel, ...fileWindows]);
    } else {
      defaultWindow = fileDefaultWindow;
      byModel = fileWindows;
    }
    // Claude Code copies each settings file's `env` over its own environment.
    const settingsEnvValue = isRecord(settings.env)
      ? settings.env[AUTO_COMPACT_WINDOW_ENV_KEY]
      : undefined;
    if (typeof settingsEnvValue === "string" || typeof settingsEnvValue === "number") {
      envValue = String(settingsEnvValue);
    }
  }

  return { envWindow: parseEnvWindow(envValue), defaultWindow, byModel };
}

/**
 * Returns the configured auto-compact window for a model, or undefined when Claude Code picks the
 * window itself ("auto" or unset).
 */
export function resolveClaudeAutoCompactWindow(
  windows: ClaudeAutoCompactWindows,
  modelId: string | null | undefined,
): number | undefined {
  if (windows.envWindow !== undefined) {
    return windows.envWindow;
  }
  const settingsKey = modelId ? claudeAutoCompactSettingsKey(modelId) : undefined;
  const modelWindow = settingsKey === undefined ? undefined : windows.byModel.get(settingsKey);
  const configuredWindow = modelWindow ?? windows.defaultWindow;
  return configuredWindow === "auto" ? undefined : configuredWindow;
}

async function readSettingsFile(
  settingsPath: string,
  logger: Logger,
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Skipped Claude settings for auto-compact window");
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function readModelWindows(modelSettings: unknown): Map<string, ConfiguredAutoCompactWindow> {
  const windows = new Map<string, ConfiguredAutoCompactWindow>();
  if (!isRecord(modelSettings)) {
    return windows;
  }
  for (const [modelKey, entry] of Object.entries(modelSettings)) {
    const window = isRecord(entry) ? parseModelWindow(entry.autoCompactWindow) : undefined;
    if (window === undefined) {
      continue;
    }
    const settingsKey = claudeAutoCompactSettingsKey(modelKey);
    // Within one file the canonical spelling wins over its dated, [1m] or provider spellings.
    if (modelKey === settingsKey || !windows.has(settingsKey)) {
      windows.set(settingsKey, window);
    }
  }
  return windows;
}

/**
 * Claude Code keys modelSettings by canonical model name, so "claude-opus-5-5[1m]", dated IDs
 * and provider IDs all share the "claude-opus-5-5" entry.
 */
function claudeAutoCompactSettingsKey(modelId: string): string {
  const withoutLongContext = modelId.trim().replace(/\[1m\]/gi, "");
  return (normalizeClaudeRuntimeModelId(withoutLongContext) ?? withoutLongContext).toLowerCase();
}

function parseSettingsWindow(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_AUTO_COMPACT_WINDOW ||
    value > MAX_AUTO_COMPACT_WINDOW
  ) {
    return undefined;
  }
  return value;
}

function parseModelWindow(value: unknown): ConfiguredAutoCompactWindow | undefined {
  return value === "auto" ? "auto" : parseSettingsWindow(value);
}

/**
 * Mirrors Claude Code's reading of CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k", "1m" or a token
 * count, clamped to the accepted range; a value that is not a size is ignored.
 */
function parseEnvWindow(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const multiplier = ENV_WINDOW_SUFFIX_MULTIPLIERS.get(trimmed.slice(-1).toLowerCase());
  const tokens =
    multiplier === undefined ? Number(trimmed) : Number.parseFloat(trimmed) * multiplier;
  if (Number.isNaN(tokens) || tokens < 1) {
    return undefined;
  }
  return Math.min(MAX_AUTO_COMPACT_WINDOW, Math.max(MIN_AUTO_COMPACT_WINDOW, Math.round(tokens)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
