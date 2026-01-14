import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const PersistedConfigSchema = z.object({
  listen: z.string().optional(),
  cors: z
    .object({
      allowedOrigins: z.array(z.string()).default([]),
    })
    .default({}),
});

export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;

const CONFIG_FILENAME = "config.json";

function getConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FILENAME);
}

export function loadPersistedConfig(paseoHome: string): PersistedConfig {
  const configPath = getConfigPath(paseoHome);

  if (!existsSync(configPath)) {
    console.log(`[Config] No config file at ${configPath}, using defaults`);
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

  console.log(`[Config] Loaded from ${configPath}`);
  return result.data;
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig
): void {
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
    console.log(`[Config] Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`);
  }
}
