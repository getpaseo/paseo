import * as fs from "node:fs/promises";
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
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
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

export function getClaudeContextWindowMaxTokens(
  modelId: string | null | undefined,
): number | undefined {
  if (modelId?.trim().toLowerCase().endsWith("[1m]")) {
    return 1_000_000;
  }
  return findClaudeModel(modelId)?.contextWindowMaxTokens;
}

interface ClaudeModelPickerOption {
  id: string;
  label?: string;
  description?: string;
  behavesAs?: string;
}

interface ClaudeSettingsModels {
  defaultModelId?: string;
  pickerOptions: ClaudeModelPickerOption[];
  replaceBuiltInOptions: boolean;
  configuredModels: AgentModelDefinition[];
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir: string,
  claudeCodeVersion?: string,
  discoveredModelIds: ReadonlySet<string> = new Set(),
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeManifestModels(claudeCodeVersion, discoveredModelIds);
  const settings = await readClaudeSettingsModels(logger, configDir);
  if (settings.pickerOptions.length === 0 && settings.configuredModels.length === 0) {
    return hardcodedModels;
  }

  const allManifestModels = getClaudeModels(claudeCodeVersion);
  const replaceBuiltIn = settings.replaceBuiltInOptions && settings.pickerOptions.length > 0;
  const models = replaceBuiltIn ? [] : [...hardcodedModels];

  for (const option of settings.pickerOptions) {
    const existingIndex = models.findIndex((candidate) => candidate.id === option.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      const hasCustomMetadata = option.label !== undefined || option.description !== undefined;
      if (existing.isSelectable === false || hasCustomMetadata) {
        models[existingIndex] = {
          ...existing,
          ...(option.label !== undefined ? { label: option.label } : {}),
          ...(option.description !== undefined ? { description: option.description } : {}),
          ...(existing.isSelectable === false ? { isSelectable: true } : {}),
        };
      }
      continue;
    }

    models.push(buildPickerOptionModel(option, allManifestModels));
  }

  if (replaceBuiltIn) {
    markDefaultModel(models, settings.defaultModelId);
    return models;
  }

  for (const model of settings.configuredModels) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    const manifestModel = allManifestModels.find((candidate) => candidate.id === model.id);
    models.push(resolveConfiguredClaudeModel({ ...manifestModel, ...model }));
  }

  return models;
}

function buildPickerOptionModel(
  option: ClaudeModelPickerOption,
  allManifestModels: readonly AgentModelDefinition[],
): AgentModelDefinition {
  const exactManifestModel = allManifestModels.find((candidate) => candidate.id === option.id);
  if (exactManifestModel) {
    const manifestBase: AgentModelDefinition = { ...exactManifestModel };
    delete manifestBase.isDefault;
    delete manifestBase.isSelectable;
    return resolveConfiguredClaudeModel({
      ...manifestBase,
      provider: "claude",
      id: option.id,
      label: option.label ?? exactManifestModel.label,
      description: option.description ?? exactManifestModel.description,
    });
  }

  const templateModel = findManifestTemplateModel(option.behavesAs, allManifestModels);
  return resolveConfiguredClaudeModel({
    provider: "claude",
    id: option.id,
    label: option.label ?? option.id,
    description: option.description ?? "From Claude settings.json modelPicker.options",
    ...(templateModel?.contextWindowMaxTokens !== undefined
      ? { contextWindowMaxTokens: templateModel.contextWindowMaxTokens }
      : {}),
    ...(templateModel?.thinkingOptions !== undefined
      ? { thinkingOptions: templateModel.thinkingOptions }
      : {}),
    ...(templateModel?.defaultThinkingOptionId !== undefined
      ? { defaultThinkingOptionId: templateModel.defaultThinkingOptionId }
      : {}),
  });
}

function findManifestTemplateModel(
  modelId: string | undefined,
  allManifestModels: readonly AgentModelDefinition[],
): AgentModelDefinition | undefined {
  if (!modelId) {
    return undefined;
  }
  const exact = allManifestModels.find((candidate) => candidate.id === modelId);
  if (exact) {
    return exact;
  }
  const normalized = normalizeClaudeManifestModelId(modelId);
  if (!normalized) {
    return undefined;
  }
  return allManifestModels.find((candidate) => candidate.id === normalized);
}

function markDefaultModel(models: AgentModelDefinition[], defaultModelId?: string): void {
  if (models.length === 0 || models.some((model) => model.isDefault)) {
    return;
  }
  const defaultIndex =
    defaultModelId !== undefined ? models.findIndex((model) => model.id === defaultModelId) : -1;
  const targetIndex = defaultIndex !== -1 ? defaultIndex : 0;
  models[targetIndex] = { ...models[targetIndex], isDefault: true };
}

async function readClaudeSettingsModels(
  logger: Logger,
  configDir: string,
): Promise<ClaudeSettingsModels> {
  const empty: ClaudeSettingsModels = {
    pickerOptions: [],
    replaceBuiltInOptions: false,
    configuredModels: [],
  };
  const settingsPath = path.join(configDir, "settings.json");

  let parsed: unknown;
  try {
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return empty;
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return empty;
  }

  const defaultModelId = readTrimmedString(parsed.model);
  const { pickerOptions, replaceBuiltInOptions } = readModelPicker(
    logger,
    settingsPath,
    parsed.modelPicker,
  );

  const configuredModels: AgentModelDefinition[] = [];
  addSettingsModel(configuredModels, parsed.model, "model");

  const env = parsed.env;
  if (env !== undefined) {
    if (!isRecord(env)) {
      logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    } else {
      for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
        addSettingsModel(configuredModels, env[envKey], `env.${envKey}`);
      }
    }
  }

  return {
    defaultModelId,
    pickerOptions,
    replaceBuiltInOptions,
    configuredModels,
  };
}

function readModelPicker(
  logger: Logger,
  settingsPath: string,
  value: unknown,
): Pick<ClaudeSettingsModels, "pickerOptions" | "replaceBuiltInOptions"> {
  if (value === undefined) {
    return { pickerOptions: [], replaceBuiltInOptions: false };
  }
  if (!isRecord(value) || !Array.isArray(value.options)) {
    logger.debug({ settingsPath }, "Claude settings.json modelPicker is invalid");
    return { pickerOptions: [], replaceBuiltInOptions: false };
  }

  const pickerOptions: ClaudeModelPickerOption[] = [];
  for (const entry of value.options) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = readTrimmedString(entry.model);
    if (!id || pickerOptions.some((option) => option.id === id)) {
      continue;
    }
    pickerOptions.push({
      id,
      label: readTrimmedString(entry.label),
      description: readTrimmedString(entry.description),
      behavesAs: readTrimmedString(entry.behavesAs),
    });
  }

  return {
    pickerOptions,
    replaceBuiltInOptions: value.replaceBuiltInOptions === true,
  };
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  const id = readTrimmedString(value);
  if (!id || models.some((model) => model.id === id)) {
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
