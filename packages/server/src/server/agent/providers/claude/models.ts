import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
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
  env?: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeModels(claudeCodeVersion);
  const settingsModels = await readClaudeSettingsModels(logger, configDir);
  const gatewayModels = await fetchClaudeGatewayModels(logger, env, fetchImpl);

  const models = [...hardcodedModels];

  for (const model of [...settingsModels, ...gatewayModels]) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    models.push(model);
  }

  return models;
}

/**
 * Discover models from an Anthropic-compatible gateway configured via
 * `ANTHROPIC_BASE_URL` (e.g. cliproxy). Mirrors Claude Code's
 * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`: only runs when the flag is set,
 * so vanilla Anthropic setups are untouched. Models the gateway exposes that
 * are not Anthropic's (GLM, deepseek ids behind the proxy) are intentionally
 * surfaced — Claude Code is an Anthropic-compatible client (see the note on
 * resolveObservedClaudeModelId). Returns [] on any miss so catalog never breaks.
 */
async function fetchClaudeGatewayModels(
  logger: Logger,
  env: NodeJS.ProcessEnv | undefined,
  fetchImpl: typeof fetch,
): Promise<AgentModelDefinition[]> {
  const baseUrl = env?.ANTHROPIC_BASE_URL?.trim();
  const discoveryEnabled = env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  if (!baseUrl || !discoveryEnabled || !/^(1|true)$/i.test(discoveryEnabled.trim())) {
    return [];
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (apiKey) headers["x-api-key"] = apiKey;

  try {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      logger.debug({ url, status: res.status }, "Claude gateway model discovery returned non-OK");
      return [];
    }
    const parsed = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = Array.isArray(parsed?.data)
      ? parsed.data
          .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
          .filter(Boolean)
      : [];
    return ids.map((id) => ({
      provider: "claude",
      id,
      label: id,
      description: `From gateway ${baseUrl}`,
    }));
  } catch (error) {
    logger.debug({ err: error, url }, "Failed to discover Claude gateway models");
    return [];
  }
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
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
