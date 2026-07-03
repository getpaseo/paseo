import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import { getClaudeManifestModels, isClaudeManifestModelId } from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export function getClaudeModels(): AgentModelDefinition[] {
  return getClaudeManifestModels();
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
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeModels();
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

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  // Check for exact match first (handles claude-opus-4-6[1m] directly)
  if (isClaudeManifestModelId(trimmed)) {
    return trimmed;
  }

  // Match single-segment major-version model names such as claude-fable-5
  // and claude-sonnet-5, including dated runtime strings from the SDK.
  const singleSegmentMatch = trimmed.match(/(?:claude-)?(fable|opus|sonnet|haiku)[-_ ]+(\d+)/i);
  if (singleSegmentMatch) {
    const family = singleSegmentMatch[1].toLowerCase();
    const major = singleSegmentMatch[2];
    const suffix = trimmed.toLowerCase().includes("[1m]") ? "[1m]" : "";
    const candidates = [`claude-${family}-${major}${suffix}`, `claude-${family}-${major}`];
    for (const candidate of candidates) {
      if (isClaudeManifestModelId(candidate)) {
        return candidate;
      }
    }
  }

  // Match: claude-{family}-{major}-{minor}[1m]? possibly followed by a date suffix
  const runtimeMatch = trimmed.match(
    /(?:claude-)?(opus|sonnet|haiku)[-_ ]+(\d+)[-.](\d+)(\[1m\])?/i,
  );
  if (!runtimeMatch) {
    return null;
  }

  const family = runtimeMatch[1].toLowerCase();
  const major = runtimeMatch[2];
  const minor = runtimeMatch[3];
  const suffix = runtimeMatch[4] ?? "";
  return `claude-${family}-${major}-${minor}${suffix}`;
}
