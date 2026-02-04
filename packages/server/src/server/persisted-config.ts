import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const LogConfigSchema = z
  .object({
    level: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .optional(),
    format: z.enum(["pretty", "json"]).optional(),
  })
  .strict();

const ProviderCredentialsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
  })
  .strict();

const ProvidersSchema = z
  .object({
    openai: ProviderCredentialsSchema.optional(),
    openrouter: ProviderCredentialsSchema.optional(),
  })
  .strict();

const FeatureDictationSchema = z
  .object({
    stt: z
      .object({
        provider: z.enum(["openai"]).optional(),
        model: z.string().min(1).optional(),
        confidenceThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureVoiceModeSchema = z
  .object({
    llm: z
      .object({
        provider: z.enum(["openrouter"]).optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    stt: z
      .object({
        provider: z.enum(["openai"]).optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        provider: z.enum(["openai"]).optional(),
        model: z.enum(["tts-1", "tts-1-hd"]).optional(),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PersistedConfigSchema = z
  .object({
    // v1 schema marker
    version: z.literal(1).optional(),

    // v1 config layout
    daemon: z
      .object({
        listen: z.string().optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        mcp: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
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
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),

    app: z
      .object({
        baseUrl: z.string().optional(),
      })
      .strict()
      .optional(),

    providers: ProvidersSchema.optional(),
    features: z
      .object({
        dictation: FeatureDictationSchema.optional(),
        voiceMode: FeatureVoiceModeSchema.optional(),
      })
      .strict()
      .optional(),

    log: LogConfigSchema.optional(),
  })
  .strict();

export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;

const CONFIG_FILENAME = "config.json";

type LoggerLike = {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: any[]): void;
};

function getConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FILENAME);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

export function loadPersistedConfig(
  paseoHome: string,
  logger?: LoggerLike
): PersistedConfig {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  if (!existsSync(configPath)) {
    log?.info(`No config file at ${configPath}, using defaults`);
    return PersistedConfigSchema.parse({});
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${configPath}: ${message}`);
  }

  const result = PersistedConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config in ${configPath}:\n${issues}`);
  }

  log?.info(`Loaded from ${configPath}`);
  return result.data;
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike
): void {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);

  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[Config] Invalid config to save:\n${issues}`);
  }

  try {
    writeFileSync(configPath, JSON.stringify(result.data, null, 2) + "\n");
    log?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`);
  }
}
