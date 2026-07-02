import { getModels, type Api, type Model } from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { PaseoAgentCatalogEntry as PaseoAgentCatalogManifestEntry } from "@getpaseo/protocol/messages";
import { z } from "zod";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  isRefreshTokenExpressionConfigured,
  resolveRefreshTokenExpression,
} from "./oauth-credentials.js";
import type { OAuthCredentialBinding } from "./oauth-store.js";
import type { PaseoAgentModelProvider, PaseoAgentModelReference } from "./pi-services.js";
import {
  PASEO_AGENT_PROVIDER_CATALOG,
  requirePaseoAgentCatalogEntry,
  type PaseoAgentCatalogRef,
} from "./catalog.js";
import { findEnvReferences } from "./env-references.js";

export const PASEO_AGENT_PROVIDER = "paseo";

const PaseoAgentModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    api: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

const PaseoAgentProviderOptionsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    api: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    authHeader: z.boolean().optional(),
    refreshToken: z.string().min(1).optional(),
    models: z.array(PaseoAgentModelSchema).min(1).optional(),
  })
  .strict();

const PaseoAgentModelProviderSchema = z
  .object({
    type: z.string().min(1),
    displayName: z.string().min(1).optional(),
    options: PaseoAgentProviderOptionsSchema.default({}),
  })
  .strict();

export const PaseoAgentConfigSchema = z
  .object({
    defaultModel: z.string().min(1).optional(),
    defaultAgent: z.string().min(1).optional(),
    defaultProfile: z.string().min(1).optional(),
    providers: z.record(z.string(), PaseoAgentModelProviderSchema).optional(),
  })
  .strict();

export type PaseoAgentConfig = z.infer<typeof PaseoAgentConfigSchema>;
export type PaseoAgentModelProviderEntry = z.infer<typeof PaseoAgentModelProviderSchema>;
export type PaseoAgentProviderModelConfig = z.infer<typeof PaseoAgentModelSchema>;
export type { PaseoAgentCatalogManifestEntry };

type PiModel = Model<Api>;
type PiModelConfig = NonNullable<PaseoAgentModelProvider["config"]["models"]>[number];
type ProviderOptions = PaseoAgentModelProviderEntry["options"];

const DEFAULT_INPUT: PiModelConfig["input"] = ["text"];
const ZERO_COST: PiModelConfig["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_MODEL_FIELDS = [
  "id",
  "label",
  "api",
  "reasoning",
  "contextWindow",
  "maxTokens",
] as const;

type ResolvedCatalogAuth =
  | { kind: "api_key"; envVar: string; keyUrl?: string; placeholder?: string; hint?: string }
  | { kind: "oauth"; flow: string };

export interface ResolvedProviderSettings {
  baseUrl: string;
  api: Api;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

function entries(config: PaseoAgentConfig): [string, PaseoAgentModelProviderEntry][] {
  return Object.entries(config.providers ?? {});
}

function getPaseoAgentPiModels(catalogEntry: PaseoAgentCatalogRef): PiModel[] {
  return getModels(catalogEntry.piProvider);
}

function requirePaseoAgentPrimaryModel(catalogEntry: PaseoAgentCatalogRef): PiModel {
  const first = getPaseoAgentPiModels(catalogEntry)[0];
  if (!first) {
    throw new Error(`Paseo Agent provider "${catalogEntry.id}" has no Pi models.`);
  }
  return first;
}

function defaultPaseoAgentPiModels(catalogEntry: PaseoAgentCatalogRef): PiModel[] {
  return catalogEntry.defaultModels === false ? [] : getPaseoAgentPiModels(catalogEntry);
}

export function resolvePaseoAgentCatalogAuth(
  catalogEntry: PaseoAgentCatalogRef,
): ResolvedCatalogAuth {
  if (catalogEntry.auth?.kind === "oauth") {
    return { kind: "oauth", flow: catalogEntry.auth.flow ?? catalogEntry.piProvider };
  }

  if (!catalogEntry.auth && getOAuthProvider(catalogEntry.piProvider)) {
    return { kind: "oauth", flow: catalogEntry.piProvider };
  }

  const envVar = catalogEntry.auth?.kind === "api_key" ? catalogEntry.auth.envVar : undefined;
  if (!envVar) {
    throw new Error(`Paseo Agent provider "${catalogEntry.id}" has no auth source.`);
  }

  return {
    kind: "api_key",
    envVar,
    ...(catalogEntry.auth?.kind === "api_key" && catalogEntry.auth.keyUrl
      ? { keyUrl: catalogEntry.auth.keyUrl }
      : {}),
    ...(catalogEntry.auth?.kind === "api_key" && catalogEntry.auth.placeholder
      ? { placeholder: catalogEntry.auth.placeholder }
      : {}),
    ...(catalogEntry.auth?.kind === "api_key" && catalogEntry.auth.hint
      ? { hint: catalogEntry.auth.hint }
      : {}),
  };
}

export function resolvePaseoAgentProviderSettings(
  entry: PaseoAgentModelProviderEntry,
  catalogEntry: PaseoAgentCatalogRef = requirePaseoAgentCatalogEntry(entry.type),
): ResolvedProviderSettings {
  const primaryModel = requirePaseoAgentPrimaryModel(catalogEntry);
  const auth = resolvePaseoAgentCatalogAuth(catalogEntry);
  const apiKey = auth.kind === "api_key" ? (entry.options.apiKey ?? `$${auth.envVar}`) : undefined;
  return {
    baseUrl: entry.options.baseUrl ?? primaryModel.baseUrl,
    api: entry.options.api ?? primaryModel.api,
    ...(apiKey ? { apiKey } : {}),
    ...(entry.options.headers ? { headers: entry.options.headers } : {}),
    ...(entry.options.authHeader ? { authHeader: entry.options.authHeader } : {}),
  };
}

function toCatalogModel(model: PiModel): PaseoAgentProviderModelConfig {
  return {
    id: model.id,
    label: model.name,
    api: model.api,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function resolvePaseoAgentProviderModels(
  entry: PaseoAgentModelProviderEntry,
  catalogEntry: PaseoAgentCatalogRef = requirePaseoAgentCatalogEntry(entry.type),
): PaseoAgentProviderModelConfig[] {
  return entry.options.models ?? defaultPaseoAgentPiModels(catalogEntry).map(toCatalogModel);
}

export function isPaseoAgentDefaultModelSelection(
  models: PaseoAgentProviderModelConfig[] | undefined,
  catalogEntry: PaseoAgentCatalogRef,
): boolean {
  if (!models) {
    return false;
  }

  const defaults = defaultPaseoAgentPiModels(catalogEntry).map(toCatalogModel);
  if (models.length !== defaults.length || defaults.length === 0) {
    return false;
  }

  return models.every((model, index) => {
    const defaultModel = defaults[index];
    return DEFAULT_MODEL_FIELDS.every((field) => model[field] === defaultModel?.[field]);
  });
}

export function paseoAgentCatalogManifests(): PaseoAgentCatalogManifestEntry[] {
  return PASEO_AGENT_PROVIDER_CATALOG.map((catalogEntry: PaseoAgentCatalogRef) => {
    const primaryModel = requirePaseoAgentPrimaryModel(catalogEntry);
    const manifest: PaseoAgentCatalogManifestEntry = {
      id: catalogEntry.id,
      label: catalogEntry.label,
      api: primaryModel.api,
      baseUrl: primaryModel.baseUrl,
      auth: resolvePaseoAgentCatalogAuth(catalogEntry),
      models: defaultPaseoAgentPiModels(catalogEntry).map(toCatalogModel),
    };
    if (catalogEntry.iconName) {
      manifest.iconName = catalogEntry.iconName;
    }
    if (catalogEntry.docsUrl) {
      manifest.docsUrl = catalogEntry.docsUrl;
    }
    if (primaryModel.headers) {
      manifest.headers = { ...primaryModel.headers };
    }
    return manifest;
  });
}

/**
 * Whether a resolved API-key value is actually configured. Mirrors Pi's config-value
 * semantics without importing Pi: literals and `!command` values count as present;
 * `$ENV` / `${ENV}` references count only when every referenced var is set.
 */
function isAuthConfigured(value: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (!value) {
    return false;
  }
  if (value.startsWith("!")) {
    return true;
  }
  const referencedVars = findEnvReferences(value);
  if (referencedVars.length === 0) {
    return true;
  }
  return referencedVars.every((name) => Boolean(env[name]));
}

export function encodePaseoAgentModelId(providerName: string, modelId: string): string {
  return `${providerName}/${modelId}`;
}

export function parsePaseoAgentModelId(modelId: string): PaseoAgentModelReference | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    return null;
  }
  return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

function applyModelOverrides(
  model: PiModel,
  options: ProviderOptions,
  override?: PaseoAgentProviderModelConfig,
): PiModelConfig {
  return {
    id: override?.id ?? model.id,
    name: override?.label ?? model.name,
    api: override?.api ?? options.api ?? model.api,
    baseUrl: options.baseUrl ?? model.baseUrl,
    reasoning: override?.reasoning ?? model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    cost: model.cost,
    contextWindow: override?.contextWindow ?? model.contextWindow,
    maxTokens: override?.maxTokens ?? model.maxTokens,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function customModelFromOptions(
  model: PaseoAgentProviderModelConfig,
  options: ProviderOptions,
  fallback: PiModel,
): PiModelConfig {
  return {
    id: model.id,
    name: model.label ?? model.id,
    api: model.api ?? options.api ?? fallback.api,
    baseUrl: options.baseUrl ?? fallback.baseUrl,
    reasoning: model.reasoning ?? false,
    input: fallback.input ?? DEFAULT_INPUT,
    cost: ZERO_COST,
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(fallback.headers ? { headers: { ...fallback.headers } } : {}),
  };
}

function toPiModels(
  entry: PaseoAgentModelProviderEntry,
  catalogEntry: PaseoAgentCatalogRef,
): PiModelConfig[] {
  const piModels = getPaseoAgentPiModels(catalogEntry);
  const piModelsById = new Map(piModels.map((model) => [model.id, model]));
  const selectedModels = entry.options.models;
  if (!selectedModels) {
    return defaultPaseoAgentPiModels(catalogEntry).map((model) =>
      applyModelOverrides(model, entry.options),
    );
  }

  const fallback = requirePaseoAgentPrimaryModel(catalogEntry);
  return selectedModels.map((model) => {
    const piModel = piModelsById.get(model.id);
    return piModel
      ? applyModelOverrides(piModel, entry.options, model)
      : customModelFromOptions(model, entry.options, fallback);
  });
}

export async function paseoAgentModelProviders(
  config: PaseoAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PaseoAgentModelProvider[]> {
  const providers: PaseoAgentModelProvider[] = [];

  for (const [name, entry] of entries(config)) {
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    const auth = resolvePaseoAgentCatalogAuth(catalogEntry);
    const settings = resolvePaseoAgentProviderSettings(entry, catalogEntry);
    const models = toPiModels(entry, catalogEntry);
    const providerConfig = {
      baseUrl: settings.baseUrl,
      api: settings.api,
      ...(settings.headers ? { headers: settings.headers } : {}),
      models,
    };

    if (auth.kind === "oauth") {
      const refreshToken = entry.options.refreshToken
        ? await resolveRefreshTokenExpression(entry.options.refreshToken, env)
        : undefined;
      providers.push({
        name,
        config: providerConfig,
        oauth: { flow: auth.flow, ...(refreshToken ? { refreshToken } : {}) },
      });
      continue;
    }

    providers.push({
      name,
      config: {
        ...providerConfig,
        ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
        ...(settings.authHeader ? { authHeader: settings.authHeader } : {}),
      },
    });
  }

  return providers;
}

export function listPaseoAgentModels(config: PaseoAgentConfig): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  for (const [name, entry] of entries(config)) {
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    for (const model of resolvePaseoAgentProviderModels(entry, catalogEntry)) {
      const id = encodePaseoAgentModelId(name, model.id);
      models.push({
        provider: PASEO_AGENT_PROVIDER,
        id,
        label: model.label ?? model.id,
        description: `${name} - ${model.id}`,
        isDefault: config.defaultModel === id,
      });
    }
  }
  return models;
}

export function paseoAgentHasUsableModel(
  config: PaseoAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
  isOAuthAuthed: (providerInstance: string, binding: OAuthCredentialBinding) => boolean = () =>
    false,
): boolean {
  return entries(config).some(([name, entry]) => {
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    const models = resolvePaseoAgentProviderModels(entry, catalogEntry);
    if (models.length === 0) {
      return false;
    }

    const auth = resolvePaseoAgentCatalogAuth(catalogEntry);
    if (auth.kind === "oauth") {
      if (
        entry.options.refreshToken &&
        isRefreshTokenExpressionConfigured(entry.options.refreshToken, env)
      ) {
        return true;
      }
      return isOAuthAuthed(name, {
        flow: auth.flow,
        baseUrl: resolvePaseoAgentProviderSettings(entry, catalogEntry).baseUrl,
      });
    }
    return isAuthConfigured(resolvePaseoAgentProviderSettings(entry, catalogEntry).apiKey, env);
  });
}

export function resolvePaseoAgentModel(
  config: PaseoAgentConfig,
  requestedModelId: string | null | undefined,
  registeredProviders: PaseoAgentModelProvider[] = paseoAgentModelInventory(config),
  agentDefaultModelId?: string | null,
): PaseoAgentModelReference | undefined {
  if (requestedModelId) {
    return parsePaseoAgentModelId(requestedModelId) ?? undefined;
  }

  for (const candidate of [agentDefaultModelId, config.defaultModel, firstModelId(config)]) {
    if (!candidate) {
      continue;
    }
    const parsed = parsePaseoAgentModelId(candidate);
    if (parsed && hasRegisteredModel(registeredProviders, parsed)) {
      return parsed;
    }
  }

  return firstRegisteredModel(registeredProviders);
}

function paseoAgentModelInventory(config: PaseoAgentConfig): PaseoAgentModelProvider[] {
  return entries(config).map(([name, entry]) => {
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    return { name, config: { models: toPiModels(entry, catalogEntry) } };
  });
}

function firstModelId(config: PaseoAgentConfig): string | undefined {
  for (const [name, entry] of entries(config)) {
    const catalogEntry = requirePaseoAgentCatalogEntry(entry.type);
    const first = resolvePaseoAgentProviderModels(entry, catalogEntry)[0];
    if (first) {
      return encodePaseoAgentModelId(name, first.id);
    }
  }
  return undefined;
}

function hasRegisteredModel(
  providers: PaseoAgentModelProvider[],
  model: PaseoAgentModelReference,
): boolean {
  return providers.some(
    (provider) =>
      provider.name === model.provider &&
      provider.config.models?.some((registered) => registered.id === model.id),
  );
}

function firstRegisteredModel(
  providers: PaseoAgentModelProvider[],
): PaseoAgentModelReference | undefined {
  for (const provider of providers) {
    const first = provider.config.models?.[0];
    if (first) {
      return { provider: provider.name, id: first.id };
    }
  }
  return undefined;
}
