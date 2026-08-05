import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  enrichClaudeCatalogModel,
  getClaudeManifestModels,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

export const CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export type ClaudeCustomModelPinEnvKey = (typeof CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS)[number];

const CLAUDE_FAMILY_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir?: string,
  claudeCodeVersion?: string,
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeModels(claudeCodeVersion);
  const settingsModels = await readClaudeSettingsModels(logger, configDir);
  if (settingsModels.length === 0) {
    return hardcodedModels;
  }

  const seenModelIds = new Set(hardcodedModels.map((model) => model.id));
  const models = [...hardcodedModels];

  for (const model of settingsModels) {
    if (seenModelIds.has(model.id)) {
      continue;
    }
    seenModelIds.add(model.id);
    models.push(model);
  }

  return models;
}

async function readClaudeSettingsModels(
  logger: Logger,
  configDir?: string,
): Promise<AgentModelDefinition[]> {
  const settingsPath = path.join(resolveClaudeConfigDir(configDir), "settings.json");

  let parsed: unknown;
  try {
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return [];
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return [];
  }

  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, parsed.model, "model");

  const env = parsed.env;
  if (env === undefined) {
    return models;
  }
  if (!isRecord(env)) {
    logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    return models;
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return models;
}

function resolveClaudeConfigDir(configDir?: string): string {
  return configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push(
    enrichClaudeCatalogModel({
      provider: "claude",
      id,
      label: id,
      description: `From Claude settings.json ${settingsKey}`,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * True when the selected model is a custom non-family ID that should pin Claude Code
 * family-alias / subagent env vars to itself.
 */
export function isClaudeCustomNonFamilyModel(modelId: string | null | undefined): boolean {
  const trimmed = typeof modelId === "string" ? modelId.trim() : "";
  if (!trimmed) {
    return false;
  }
  if (CLAUDE_FAMILY_ALIASES.has(trimmed.toLowerCase())) {
    return false;
  }
  // First-party catalog IDs and gateway-prefixed first-party forms normalize to a manifest ID.
  if (normalizeClaudeRuntimeModelId(trimmed)) {
    return false;
  }
  return true;
}

export function buildClaudeCustomModelEnvPins(
  modelId: string,
): Record<ClaudeCustomModelPinEnvKey, string> {
  const pins = {} as Record<ClaudeCustomModelPinEnvKey, string>;
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    pins[key] = modelId;
  }
  return pins;
}

function hasNonEmptyEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fill missing Claude family/subagent pin env keys from a custom non-family selected model.
 * User-provided non-empty values are preserved. First-party/family models are a no-op.
 */
export function applyClaudeCustomModelEnvPins(
  env: NodeJS.ProcessEnv,
  modelId: string | null | undefined,
): NodeJS.ProcessEnv {
  if (!isClaudeCustomNonFamilyModel(modelId)) {
    return env;
  }
  const selectedModel = (modelId as string).trim();
  const pins = buildClaudeCustomModelEnvPins(selectedModel);
  let changed = false;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of CLAUDE_CUSTOM_MODEL_PIN_ENV_KEYS) {
    if (hasNonEmptyEnvValue(next[key])) {
      continue;
    }
    next[key] = pins[key];
    changed = true;
  }
  return changed ? next : env;
}

export const CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/**
 * Resolve the preferred context-window max for a selected Claude model.
 * Configured profile/additional model windows win over first-party catalog defaults.
 */
export function resolveClaudeContextWindowMaxTokens(options: {
  modelId: string | null | undefined;
  profileModels?: Array<{ id: string; contextWindowMaxTokens?: number }>;
}): number | undefined {
  const trimmed = typeof options.modelId === "string" ? options.modelId.trim() : "";
  if (!trimmed) {
    return undefined;
  }

  const profileMatch = options.profileModels?.find((model) => model.id === trimmed);
  if (
    typeof profileMatch?.contextWindowMaxTokens === "number" &&
    Number.isFinite(profileMatch.contextWindowMaxTokens) &&
    profileMatch.contextWindowMaxTokens > 0
  ) {
    return Math.trunc(profileMatch.contextWindowMaxTokens);
  }

  return findClaudeModel(trimmed)?.contextWindowMaxTokens;
}

/**
 * Fill-if-missing CLAUDE_CODE_AUTO_COMPACT_WINDOW from a configured context window.
 */
export function applyClaudeAutoCompactWindowEnv(
  env: NodeJS.ProcessEnv,
  contextWindowMaxTokens: number | undefined,
): NodeJS.ProcessEnv {
  if (
    typeof contextWindowMaxTokens !== "number" ||
    !Number.isFinite(contextWindowMaxTokens) ||
    contextWindowMaxTokens <= 0
  ) {
    return env;
  }
  if (hasNonEmptyEnvValue(env[CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY])) {
    return env;
  }
  return {
    ...env,
    [CLAUDE_AUTO_COMPACT_WINDOW_ENV_KEY]: String(Math.trunc(contextWindowMaxTokens)),
  };
}
