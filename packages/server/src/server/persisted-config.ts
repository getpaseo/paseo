import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  AgentProviderRuntimeSettingsMapSchema,
  migrateProviderSettings,
  ProviderOverridesSchema,
} from "./agent/provider-launch-config.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";
import {
  AgentProfileSchema,
  AgentSkillSelectionSchema,
  PluginIdSchema,
  PluginSourceSchema,
  TerminalProfileSchema,
} from "@getpaseo/protocol/messages";
import { PaseoServicePortAllocationSchema } from "@getpaseo/protocol/paseo-config-schema";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const LogFormatSchema = z.enum(["pretty", "json"]);

const LogConfigSchema = z
  .object({
    // Legacy global log settings (kept for backwards compatibility).
    level: LogLevelSchema.optional(),
    format: LogFormatSchema.optional(),

    console: z
      .object({
        level: LogLevelSchema.optional(),
        format: LogFormatSchema.optional(),
      })
      .strict()
      .optional(),

    file: z
      .object({
        level: LogLevelSchema.optional(),
        path: z.string().min(1).optional(),
        rotate: z
          .object({
            maxSize: z.string().min(1).optional(),
            maxFiles: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const OpenAiSpeechEndpointSchema = z
  .object({
    apiKey: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
  })
  .strict();

const OpenAiProviderSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    stt: OpenAiSpeechEndpointSchema.optional(),
    tts: OpenAiSpeechEndpointSchema.optional(),
  })
  .strict();

const LocalSpeechProviderSchema = z
  .object({
    modelsDir: z.string().min(1).optional(),
  })
  .strict();

const ProvidersSchema = z
  .object({
    openai: OpenAiProviderSchema.optional(),
    local: LocalSpeechProviderSchema.optional(),
  })
  .strict();

const WorktreesConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    servicePorts: PaseoServicePortAllocationSchema.optional(),
  })
  .strict();

const BcryptHashSchema = z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, {
  message: "Expected a bcrypt hash",
});

const DaemonAuthSchema = z
  .object({
    password: BcryptHashSchema.optional(),
  })
  .strict();

const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local"]));

const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
        confidenceThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureVoiceModeSchema = z
  .object({
    enabled: z.boolean().optional(),
    llm: z
      .object({
        provider: z.string().optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    turnDetection: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
        speakerId: z.number().int().optional(),
        speed: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureWebUiSchema = z
  .object({
    enabled: z.boolean().optional(),
    distDir: z.string().min(1).optional(),
  })
  .strict();

const StructuredGenerationProviderConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const AgentMetadataGenerationSchema = z
  .object({
    providers: z.array(StructuredGenerationProviderConfigSchema).optional(),
  })
  .strict();

const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;

function isLegacyProviderEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const command = (value as Record<string, unknown>).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return false;
  }

  return typeof (command as Record<string, unknown>).mode === "string";
}

function normalizeAgentProviders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const rawProviders = value as Record<string, unknown>;
  const hasLegacyEntries = Object.values(rawProviders).some((entry) =>
    isLegacyProviderEntry(entry),
  );
  if (!hasLegacyEntries) {
    return value;
  }

  const legacyEntries: Record<string, unknown> = {};
  const normalizedEntries: Record<string, unknown> = {};

  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    if (isLegacyProviderEntry(providerValue)) {
      legacyEntries[providerId] = providerValue;
      continue;
    }
    normalizedEntries[providerId] = providerValue;
  }

  const parsedLegacyEntries = AgentProviderRuntimeSettingsMapSchema.safeParse(legacyEntries);
  if (!parsedLegacyEntries.success) {
    return value;
  }

  return {
    ...normalizedEntries,
    ...migrateProviderSettings(parsedLegacyEntries.data, [...BUILTIN_PROVIDER_IDS]),
  };
}

export const PersistedConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // v1 schema marker
    version: z.literal(1).optional(),

    imports: z.array(z.string().min(1)).optional(),
    writeTo: z.string().min(1).optional(),

    // v1 config layout
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        trustedProxies: z.union([z.literal(true), z.array(z.string())]).optional(),
        mcp: z
          .object({
            enabled: z.boolean().optional(),
            injectIntoAgents: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        browserTools: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        git: z
          .object({
            maxProcessesPerSecond: z.number().int().positive().optional(),
            maxProcessConcurrency: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        autoArchiveAfterMerge: z.boolean().optional(),
        enableTerminalAgentHooks: z.boolean().optional(),
        appendSystemPrompt: z.string().optional(),
        terminalProfiles: z.array(TerminalProfileSchema).optional(),
        agentProfiles: z.array(AgentProfileSchema).optional(),
        cors: z
          .object({
            allowedOrigins: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            publicEndpoint: z.string().optional(),
            useTls: z.boolean().optional(),
            publicUseTls: z.boolean().optional(),
          })
          .strict()
          .optional(),
        serviceProxy: z
          .object({
            // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
            // Parsed only to suppress optional public/listen layers for old configs;
            // localhost service proxying remains always enabled.
            enabled: z.boolean().optional(),
            listen: z.string().optional(),
            publicBaseUrl: z.url().optional(),
          })
          .strict()
          .optional(),
        auth: DaemonAuthSchema.optional(),
      })
      .strict()
      .transform(({ allowedHosts, ...daemon }) => {
        const hostnames = daemon.hostnames ?? allowedHosts;
        return hostnames === undefined ? daemon : { ...daemon, hostnames };
      })
      .optional(),

    app: z
      .object({
        baseUrl: z.string().optional(),
      })
      .strict()
      .optional(),

    providers: ProvidersSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    worktrees: WorktreesConfigSchema.optional(),
    agents: z
      .object({
        providers: z.preprocess(normalizeAgentProviders, ProviderOverridesSchema).optional(),
        catalogRefreshTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
        metadataGeneration: AgentMetadataGenerationSchema.optional(),
        skills: z.object({ selection: AgentSkillSelectionSchema.optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    features: z
      .object({
        dictation: FeatureDictationSchema.optional(),
        voiceMode: FeatureVoiceModeSchema.optional(),
        webUi: FeatureWebUiSchema.optional(),
      })
      .strict()
      .optional(),

    log: LogConfigSchema.optional(),
  })
  .strict();

type PersistedConfigSchemaOutput = z.infer<typeof PersistedConfigSchema>;

export type PersistedConfig = Omit<PersistedConfigSchemaOutput, "agents"> & {
  agents?: Omit<NonNullable<PersistedConfigSchemaOutput["agents"]>, "providers"> & {
    providers?: AgentProviderRuntimeSettingsMap;
  };
};

export interface ConfigStructuralKeys {
  $schema?: string;
  version?: 1;
  imports?: string[];
  writeTo?: string;
}

export interface ConfigLayer {
  path: string;
  body: PersistedConfig;
  structural: ConfigStructuralKeys;
  raw: string;
}

export interface ConfigStack {
  rootPath: string;
  layers: ConfigLayer[];
  writeTargetPath: string;
  effective: PersistedConfig;
}

const CONFIG_FILENAME = "config.json";
const DEFAULT_PERSISTED_CONFIG = PersistedConfigSchema.parse({
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    cors: {
      allowedOrigins: ["https://app.paseo.sh"],
    },
    relay: {
      enabled: false,
    },
  },
  app: {
    baseUrl: "https://app.paseo.sh",
  },
}) as PersistedConfig;

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

function getConfigPath(paseoHome: string): string {
  return path.resolve(paseoHome, CONFIG_FILENAME);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

export function deepMerge<T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;
    const currentValue = next[key];
    if (isRecord(currentValue) && isRecord(patchValue)) {
      next[key] = deepMerge(currentValue, patchValue);
      continue;
    }
    next[key] = patchValue;
  }

  return next as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Removed config fields are stripped before parsing so the strict schema does not
// reject a config written by an older release. The stripped values are discarded,
// not migrated — there is no back-compat for the removed `providers.openai.voice`
// block (use `providers.openai.stt` / `providers.openai.tts`).
function stripRemovedConfigFields(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  const root = { ...(parsed as Record<string, unknown>) };
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return root;
  }

  const providersRecord = { ...(providers as Record<string, unknown>) };

  const local = providersRecord.local;
  if (local && typeof local === "object" && !Array.isArray(local)) {
    const localRecord = { ...(local as Record<string, unknown>) };
    delete localRecord.autoDownload;
    providersRecord.local = localRecord;
  }

  const openai = providersRecord.openai;
  if (openai && typeof openai === "object" && !Array.isArray(openai)) {
    const openaiRecord = { ...(openai as Record<string, unknown>) };
    // COMPAT(openaiVoiceConfig): added 2026-06-30, remove after 2026-12-30.
    // Drop a `providers.openai.voice` block left by an older release so the strict
    // schema doesn't reject it. The value is discarded, not migrated — there is no
    // back-compat; configure `providers.openai.stt` / `providers.openai.tts` instead.
    delete openaiRecord.voice;
    providersRecord.openai = openaiRecord;
  }

  root.providers = providersRecord;
  return root;
}

function formatValidationIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function splitConfig(config: PersistedConfigSchemaOutput): {
  structural: ConfigStructuralKeys;
  body: PersistedConfig;
} {
  const { $schema, version, imports, writeTo, ...body } = config;
  const structural: ConfigStructuralKeys = {};
  if ($schema !== undefined) structural.$schema = $schema;
  if (version !== undefined) structural.version = version;
  if (imports !== undefined) structural.imports = imports;
  if (writeTo !== undefined) structural.writeTo = writeTo;
  const jsonBody = JSON.parse(JSON.stringify(body)) as PersistedConfig;
  return { structural, body: jsonBody };
}

function parseConfigFile(raw: string, configPath: string): Omit<ConfigLayer, "path" | "raw"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${configPath}: ${message}`, {
      cause: err,
    });
  }

  const migrated = stripRemovedConfigFields(parsed);
  const result = PersistedConfigSchema.safeParse(migrated);
  if (!result.success) {
    throw new Error(
      `[Config] Invalid config in ${configPath}:\n${formatValidationIssues(result.error)}`,
    );
  }
  return splitConfig(result.data);
}

function resolveConfigReference(configPath: string, reference: string): string {
  const expanded = reference.startsWith("~/")
    ? path.join(homedir(), reference.slice(2))
    : reference;
  return path.resolve(path.dirname(configPath), expanded);
}

interface LoadLayerParams {
  requestedPath: string;
  importingPath?: string;
  ancestry: string[];
  loadedByPath: Map<string, ConfigLayer>;
  isRoot: boolean;
}

function loadLayer(params: LoadLayerParams): { layer: ConfigLayer; layers: ConfigLayer[] } {
  const requestedPath = path.resolve(params.requestedPath);
  if (!existsSync(requestedPath)) {
    if (params.importingPath) {
      throw new Error(
        `[Config] Import ${requestedPath} referenced by ${params.importingPath} does not exist`,
      );
    }
    throw new Error(`[Config] Failed to read ${requestedPath}: file does not exist`);
  }

  let configPath: string;
  try {
    configPath = realpathSync(requestedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to resolve ${requestedPath}: ${message}`, { cause: err });
  }

  const cycleStart = params.ancestry.indexOf(configPath);
  if (cycleStart !== -1) {
    const cycle = [...params.ancestry.slice(cycleStart), configPath].join(" -> ");
    throw new Error(`[Config] Config import cycle: ${cycle}`);
  }

  const loaded = params.loadedByPath.get(configPath);
  if (loaded) {
    return { layer: loaded, layers: [] };
  }

  let raw: string;
  try {
    if (params.isRoot) ensurePrivateFile(configPath);
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${configPath}: ${message}`, { cause: err });
  }

  const parsed = parseConfigFile(raw, configPath);
  if (!params.isRoot && parsed.structural.writeTo !== undefined) {
    throw new Error(
      `[Config] Invalid config in ${configPath}:\n  - writeTo: writeTo is only allowed in the root config file`,
    );
  }

  const layer: ConfigLayer = { path: configPath, raw, ...parsed };
  params.loadedByPath.set(configPath, layer);
  const ancestry = [...params.ancestry, configPath];
  const layers: ConfigLayer[] = [];
  for (const importedPath of layer.structural.imports ?? []) {
    const imported = loadLayer({
      requestedPath: resolveConfigReference(configPath, importedPath),
      importingPath: configPath,
      ancestry,
      loadedByPath: params.loadedByPath,
      isRoot: false,
    });
    layers.push(...imported.layers);
  }
  layers.push(layer);
  return { layer, layers };
}

function validateEffectiveConfig(config: PersistedConfig, context: string): PersistedConfig {
  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`[Config] Invalid ${context}:\n${formatValidationIssues(result.error)}`);
  }
  return splitConfig(result.data).body;
}

function mergeLayers(layers: readonly ConfigLayer[], writeTarget?: ConfigLayer): PersistedConfig {
  let effective: PersistedConfig = {};
  for (const layer of layers) {
    const body = writeTarget && layer.path === writeTarget.path ? writeTarget.body : layer.body;
    effective = deepMerge(effective, body);
  }
  return effective;
}

function initializeRootConfig(configPath: string, logger?: LoggerLike): void {
  try {
    writePrivateFileAtomicSync(
      configPath,
      JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n",
    );
    logger?.info(`Initialized config file at ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to initialize ${configPath}: ${message}`, { cause: err });
  }
}

export function loadConfigStack(paseoHome: string, logger?: LoggerLike): ConfigStack {
  const log = getLogger(logger);
  const requestedRootPath = getConfigPath(paseoHome);
  if (!existsSync(requestedRootPath)) initializeRootConfig(requestedRootPath, log);

  const loaded = loadLayer({
    requestedPath: requestedRootPath,
    ancestry: [],
    loadedByPath: new Map(),
    isRoot: true,
  });
  const rootPath = loaded.layer.path;
  const effective = validateEffectiveConfig(mergeLayers(loaded.layers), "merged config");

  const writeTo = loaded.layer.structural.writeTo;
  const requestedWriteTarget = writeTo ? resolveConfigReference(rootPath, writeTo) : rootPath;
  const resolvedWriteTarget = existsSync(requestedWriteTarget)
    ? realpathSync(requestedWriteTarget)
    : requestedWriteTarget;
  const writeTarget = loaded.layers.find((layer) => layer.path === resolvedWriteTarget);
  if (!writeTarget) {
    throw new Error(
      `[Config] writeTo in ${rootPath} resolves to ${requestedWriteTarget}, which is not the root config or an imported file`,
    );
  }

  log?.info(`Loaded from ${rootPath}`);
  return {
    rootPath,
    layers: loaded.layers,
    writeTargetPath: writeTarget.path,
    effective,
  };
}

export function loadPersistedConfig(paseoHome: string, logger?: LoggerLike): PersistedConfig {
  return loadConfigStack(paseoHome, logger).effective;
}

function deepDiff(
  desired: Record<string, unknown>,
  otherLayers: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [key, desiredValue] of Object.entries(desired)) {
    const otherValue = otherLayers[key];
    if (isDeepStrictEqual(desiredValue, otherValue)) continue;
    if (isRecord(desiredValue) && isRecord(otherValue)) {
      const nested = deepDiff(desiredValue, otherValue);
      if (Object.keys(nested).length > 0) diff[key] = nested;
      continue;
    }
    diff[key] = desiredValue;
  }
  return diff;
}

function collectDifferentPaths(desired: unknown, actual: unknown, prefix: string[] = []): string[] {
  if (isDeepStrictEqual(desired, actual)) return [];
  if (!isRecord(desired) || !isRecord(actual)) return [prefix.join(".")];

  const paths: string[] = [];
  const keys = new Set([...Object.keys(desired), ...Object.keys(actual)]);
  for (const key of keys) {
    const nextPrefix = [...prefix, key];
    const desiredHasKey = Object.hasOwn(desired, key);
    const actualHasKey = Object.hasOwn(actual, key);
    if (!desiredHasKey || !actualHasKey) {
      paths.push(nextPrefix.join("."));
      continue;
    }
    paths.push(...collectDifferentPaths(desired[key], actual[key], nextPrefix));
  }
  return paths;
}

function definesPath(config: PersistedConfig, fieldPath: string): boolean {
  let current: unknown = config;
  for (const segment of fieldPath.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function findShadowingLayer(stack: ConfigStack, fieldPath: string): ConfigLayer | undefined {
  for (let index = stack.layers.length - 1; index >= 0; index -= 1) {
    const layer = stack.layers[index];
    if (layer.path !== stack.writeTargetPath && definesPath(layer.body, fieldPath)) return layer;
  }
  return undefined;
}

function validateConfigToSave(config: PersistedConfig): PersistedConfigSchemaOutput {
  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`[Config] Invalid config to save:\n${formatValidationIssues(result.error)}`);
  }
  return result.data;
}

function writeConfigFile(
  configPath: string,
  config: PersistedConfigSchemaOutput,
  logger?: LoggerLike,
): void {
  try {
    writePrivateFileAtomicSync(configPath, JSON.stringify(config, null, 2) + "\n");
    logger?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`, { cause: err });
  }
}

export function saveConfigStack(
  stack: ConfigStack,
  config: PersistedConfig,
  logger?: LoggerLike,
): void {
  const desired = splitConfig(validateConfigToSave(config)).body;
  const writeTarget = stack.layers.find((layer) => layer.path === stack.writeTargetPath);
  if (!writeTarget) {
    throw new Error(`[Config] Writable config file ${stack.writeTargetPath} is not in the stack`);
  }

  const otherLayers = stack.layers.filter((layer) => layer.path !== stack.writeTargetPath);
  const otherEffective = mergeLayers(otherLayers);
  const candidateBody = deepDiff(desired, otherEffective) as PersistedConfig;
  const candidateConfig = validateConfigToSave({
    ...writeTarget.structural,
    ...candidateBody,
  });
  const candidateLayer: ConfigLayer = {
    ...writeTarget,
    body: splitConfig(candidateConfig).body,
  };
  const simulated = validateEffectiveConfig(
    mergeLayers(stack.layers, candidateLayer),
    "merged config",
  );

  if (!isDeepStrictEqual(simulated, desired)) {
    const fieldPaths = collectDifferentPaths(desired, simulated);
    const issues = fieldPaths.map((fieldPath) => {
      const shadowingLayer = findShadowingLayer(stack, fieldPath);
      if (!shadowingLayer) {
        return `${fieldPath} cannot be represented by the writable config file.`;
      }
      return `${fieldPath} is defined in ${shadowingLayer.path}, which overrides the writable config file. Change it there instead.`;
    });
    throw new Error(`[Config] Cannot save config:\n  - ${issues.join("\n  - ")}`);
  }

  writeConfigFile(stack.writeTargetPath, candidateConfig, getLogger(logger));
}

export function restoreConfigWriteTarget(stack: ConfigStack, logger?: LoggerLike): void {
  const writeTarget = stack.layers.find((layer) => layer.path === stack.writeTargetPath);
  if (!writeTarget) {
    throw new Error(`[Config] Writable config file ${stack.writeTargetPath} is not in the stack`);
  }
  try {
    writePrivateFileAtomicSync(stack.writeTargetPath, writeTarget.raw);
    getLogger(logger)?.info(`Restored ${stack.writeTargetPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to restore ${stack.writeTargetPath}: ${message}`, {
      cause: err,
    });
  }
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): void {
  const configPath = getConfigPath(paseoHome);
  if (!existsSync(configPath)) {
    writeConfigFile(configPath, validateConfigToSave(config), getLogger(logger));
    return;
  }
  saveConfigStack(loadConfigStack(paseoHome, logger), config, logger);
}
