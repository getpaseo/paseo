import { readFile } from "node:fs/promises";
import { PluginRegistriesSchema } from "@getpaseo/protocol/plugin-registry";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  AgentProviderRuntimeSettingsMapSchema,
  migrateProviderSettings,
  ProviderOverridesSchema,
} from "./agent/provider-launch-config.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import {
  ensurePrivateFile,
  ensurePrivateFileAsync,
  writePrivateFileAtomic,
  writePrivateFileAtomicSync,
} from "./private-files.js";
import { AgentProfileSchema, AgentSkillSelectionSchema } from "@getpaseo/protocol/agent-profile";
import { PluginIdSchema, PluginSourceSchema } from "@getpaseo/protocol/plugin-config";
import { TerminalProfileSchema } from "@getpaseo/protocol/terminal-profile";
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

const LocalSpeechProviderSchema = z
  .object({
    modelsDir: z.string().min(1).optional(),
  })
  .strict();

const ProvidersSchema = z
  .object({
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

const SpeechModelSchema = z.string().min(1).optional();
const OpenAiConnectionFields = {
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
};

export const SpeechSttConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("local"),
      model: SpeechModelSchema,
      language: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      ...OpenAiConnectionFields,
      model: SpeechModelSchema,
      language: z.string().trim().min(1).optional(),
      confidenceThreshold: z.number().optional(),
    })
    .strict(),
]);

export const SpeechTtsConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("local"),
      model: SpeechModelSchema,
      speakerId: z.number().int().optional(),
      speed: z.number().optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      ...OpenAiConnectionFields,
      model: SpeechModelSchema,
      voice: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: SpeechSttConfigSchema.optional(),
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
    stt: SpeechSttConfigSchema.optional(),
    turnDetection: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
      })
      .strict()
      .optional(),
    tts: SpeechTtsConfigSchema.optional(),
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

    // v1 config layout
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        trustedProxies: z
          .union([z.literal(true), z.array(z.string())])
          .optional()
          .describe(
            'Express trusted proxy setting for X-Forwarded-* headers. Defaults to ["loopback"]. Use true only when the final trusted proxy overwrites client-supplied forwarded headers.',
          ),
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
            requireProtectedSecurity: z
              .boolean()
              .optional()
              .describe(
                "Admit only relay clients that negotiate protected endpoint security (replay protection). Defaults to false; older clients still connect while it is off.",
              ),
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
            enabled: z
              .boolean()
              .optional()
              .describe(
                "Compatibility shim. false suppresses optional service proxy listen/public layers only; localhost proxying remains enabled.",
              ),
            listen: z
              .string()
              .optional()
              .describe(
                "Optional service-only listener address. Presence enables the standalone service proxy listener.",
              ),
            publicBaseUrl: z
              .url()
              .optional()
              .describe("Optional public base URL for service host aliases."),
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
    pluginRegistries: PluginRegistriesSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    worktrees: WorktreesConfigSchema.optional(),
    agents: z
      .object({
        providers: z.preprocess(normalizeAgentProviders, ProviderOverridesSchema).optional(),
        idleRuntimeCleanup: z.boolean().optional(),
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
  warn?(...args: unknown[]): void;
}

function getConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FILENAME);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configRecord(value: unknown): Record<string, unknown> | undefined {
  return isConfigRecord(value) ? value : undefined;
}

// COMPAT(speechProviderConfig): added in v0.12.0, remove after 2027-04-26.
// Fold shared credentials once at the file boundary; consumers see only the strict
// per-site shape. Never include credential values in diagnostics.
function normalizeSpeechProviderConfig(parsed: unknown, logger?: LoggerLike): unknown {
  if (!isConfigRecord(parsed)) return parsed;
  const root = structuredClone(parsed);
  const providers = configRecord(root.providers);
  const legacy = configRecord(providers?.openai);
  const features = configRecord(root.features);
  const foldedKeys = new Set<string>();
  for (const [feature, kind] of [
    ["dictation", "stt"],
    ["voiceMode", "stt"],
    ["voiceMode", "tts"],
  ] as const) {
    const site = configRecord(configRecord(features?.[feature])?.[kind]);
    if (site) normalizeSpeechSite(site, kind, legacy, foldedKeys);
  }
  if (legacy) warnDiscardedSpeechKeys(legacy, foldedKeys, logger);
  if (providers) {
    delete providers.openai;
    const local = configRecord(providers.local);
    if (local) delete local.autoDownload;
  }
  return root;
}

function normalizeSpeechSite(
  site: Record<string, unknown>,
  kind: "stt" | "tts",
  legacy: Record<string, unknown> | undefined,
  foldedKeys: Set<string>,
) {
  site.provider =
    typeof site.provider === "string"
      ? site.provider.trim().toLowerCase()
      : (site.provider ?? "local");
  if (kind === "stt" && site.provider === "local") {
    delete site.confidenceThreshold;
  }
  if (kind === "tts") {
    if (site.provider === "local") delete site.voice;
    if (site.provider === "openai") {
      delete site.speakerId;
      delete site.speed;
    }
  }
  if (site.provider !== "openai" || !legacy) return;
  const endpoint = configRecord(legacy[kind]);
  for (const field of ["apiKey", "baseUrl"] as const) {
    if (site[field] !== undefined) continue;
    if (endpoint?.[field] !== undefined) {
      site[field] = endpoint[field];
      foldedKeys.add(`providers.openai.${kind}.${field}`);
    } else if (legacy[field] !== undefined) {
      site[field] = legacy[field];
      foldedKeys.add(`providers.openai.${field}`);
    }
  }
}

function warnDiscardedSpeechKeys(
  legacy: Record<string, unknown>,
  foldedKeys: Set<string>,
  logger?: LoggerLike,
) {
  const keys = [
    ["providers.openai.apiKey", legacy.apiKey],
    ...["stt", "tts"].map((kind) => [
      `providers.openai.${kind}.apiKey`,
      configRecord(legacy[kind])?.apiKey,
    ]),
  ] as const;
  for (const [keyPath, key] of keys) {
    if (key && typeof keyPath === "string" && !foldedKeys.has(keyPath)) {
      const message = `Dropped ${keyPath}: no use site in config.json selects OpenAI; re-enter it when selecting OpenAI.`;
      if (logger?.warn) logger.warn(message);
      else console.warn(message);
    }
  }
}

export function loadPersistedConfig(paseoHome: string, logger?: LoggerLike): PersistedConfig {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  if (!existsSync(configPath)) {
    try {
      writePrivateFileAtomicSync(
        configPath,
        JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n",
      );
      log?.info(`Initialized config file at ${configPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[Config] Failed to initialize ${configPath}: ${message}`, { cause: err });
    }
  }

  let raw: string;
  try {
    ensurePrivateFile(configPath);
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${configPath}: ${message}`, {
      cause: err,
    });
  }

  const config = parseConfigFile(configPath, raw, log);
  log?.info(`Loaded from ${configPath}`);
  return config;
}

/** Runtime config IO. Startup and offline CLI consumers retain their synchronous entry points. */
export async function loadPersistedConfigAsync(
  paseoHome: string,
  logger?: LoggerLike,
): Promise<PersistedConfig> {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);
  let raw: string;
  await ensurePrivateFileAsync(configPath);
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `[Config] Failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      raw = JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n";
      await writePrivateFileAtomic(configPath, raw);
      log?.info(`Initialized config file at ${configPath}`);
    } catch (initializationError) {
      throw new Error(
        `[Config] Failed to initialize ${configPath}: ${initializationError instanceof Error ? initializationError.message : String(initializationError)}`,
        { cause: initializationError },
      );
    }
  }
  const config = parseConfigFile(configPath, raw, log);
  log?.info(`Loaded from ${configPath}`);
  return config;
}

/** Observe the file without initializing a home, identity, or default configuration. */
export function readPersistedConfig(
  paseoHome: string,
  options: { defaultsIfMissing?: boolean } = {},
): PersistedConfig {
  const configPath = getConfigPath(paseoHome);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return options.defaultsIfMissing ? structuredClone(DEFAULT_PERSISTED_CONFIG) : {};
    throw error;
  }
  return parseConfigFile(configPath, raw);
}

function parseConfigFile(configPath: string, raw: string, logger?: LoggerLike): PersistedConfig {
  let parsed: unknown;
  try {
    parsed = parseConfigText(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${configPath}: ${message}`, {
      cause: err,
    });
  }

  const result = PersistedConfigSchema.safeParse(normalizeSpeechProviderConfig(parsed, logger));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config in ${configPath}:\n${issues}`);
  }
  return result.data as PersistedConfig;
}

/** Editors such as Windows Notepad save UTF-8 with a byte order mark, which JSON.parse rejects. */
function parseConfigText(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function configPathParts(field: string): string[] {
  const parts = field.split(".");
  let schema: z.ZodType = PersistedConfigSchema;
  for (const part of parts) {
    if (!part || ["__proto__", "prototype", "constructor"].includes(part)) {
      throw new Error(`Invalid configuration path: ${field}`);
    }
    while (
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodDefault ||
      schema instanceof z.ZodPipe
    )
      schema = (schema instanceof z.ZodPipe ? schema.in : schema.unwrap()) as z.ZodType;
    if (schema instanceof z.ZodUnion) {
      const variant = schema.options.find(
        (option) => option instanceof z.ZodObject && Object.hasOwn(option.shape, part),
      );
      if (variant instanceof z.ZodObject) schema = variant;
    }
    if (!(schema instanceof z.ZodObject) || !Object.hasOwn(schema.shape, part)) {
      throw new Error(
        `Unknown configuration path: ${field}. Replace its containing object with JSON for dynamic keys.`,
      );
    }
    schema = schema.shape[part];
  }
  return parts;
}

export function getPersistedConfigValue(config: PersistedConfig, field: string): unknown {
  return configPathParts(field).reduce<unknown>(
    (value, part) =>
      value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined,
    config,
  );
}

export function editPersistedConfig(
  paseoHome: string,
  field: string,
  edit: { value: unknown } | { unset: true },
): PersistedConfig {
  const parts = configPathParts(field);
  if (field === "daemon.auth" || field.startsWith("daemon.auth.")) {
    throw new Error("Use daemon set-password to change the daemon password.");
  }
  const config = readPersistedConfig(paseoHome, { defaultsIfMissing: true });
  let object = config as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    object[part] ??= {};
    object = object[part] as Record<string, unknown>;
  }
  const key = parts.at(-1)!;
  if (field === "daemon") {
    const previousAuth = config.daemon?.auth;
    const nextAuth =
      "value" in edit && edit.value && typeof edit.value === "object"
        ? (edit.value as Record<string, unknown>).auth
        : undefined;
    if (JSON.stringify(previousAuth) !== JSON.stringify(nextAuth))
      throw new Error("Use daemon set-password to change the daemon password.");
  }
  if ("unset" in edit) delete object[key];
  else object[key] = edit.value;
  savePersistedConfig(paseoHome, config);
  return config;
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): void {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  const data = serializePersistedConfig(config);

  try {
    writePrivateFileAtomicSync(configPath, data);
    log?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`, {
      cause: err,
    });
  }
}

function serializePersistedConfig(config: PersistedConfig): string {
  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config to save:\n${issues}`);
  }

  return JSON.stringify(result.data, null, 2) + "\n";
}

export async function savePersistedConfigAsync(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): Promise<void> {
  const configPath = getConfigPath(paseoHome);
  const data = serializePersistedConfig(config);
  try {
    await writePrivateFileAtomic(configPath, data);
    getLogger(logger)?.info(`Saved to ${configPath}`);
  } catch (error) {
    throw new Error(
      `[Config] Failed to write ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
