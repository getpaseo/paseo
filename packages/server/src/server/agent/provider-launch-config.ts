import { z } from "zod";

import { execFileSync } from "node:child_process";
import path from "node:path";
import { isCommandAvailable } from "../../utils/executable.js";
import type { AgentProvider } from "./agent-sdk-types.js";
import { AgentProviderSchema } from "./provider-manifest.js";

const ProviderCommandDefaultSchema = z
  .object({
    mode: z.literal("default"),
  })
  .strict();

const ProviderCommandAppendSchema = z
  .object({
    mode: z.literal("append"),
    args: z.array(z.string()).optional(),
  })
  .strict();

const ProviderCommandReplaceSchema = z
  .object({
    mode: z.literal("replace"),
    argv: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const ProviderCommandSchema = z.discriminatedUnion("mode", [
  ProviderCommandDefaultSchema,
  ProviderCommandAppendSchema,
  ProviderCommandReplaceSchema,
]);

export const ProviderRuntimeSettingsSchema = z
  .object({
    command: ProviderCommandSchema.optional(),
    env: z.record(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
  })
  .strict();

const ProviderProfileThinkingOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const ProviderProfileModelSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    thinkingOptions: z.array(ProviderProfileThinkingOptionSchema).optional(),
  })
  .strict();

export const ProviderOverrideSchema = z
  .object({
    extends: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    env: z.record(z.string()).optional(),
    models: z.array(ProviderProfileModelSchema).optional(),
    disallowedTools: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    order: z.number().optional(),
  })
  .strict();

export const AgentProviderRuntimeSettingsMapSchema = z.record(
  AgentProviderSchema,
  ProviderRuntimeSettingsSchema,
);

export type ProviderCommand = z.infer<typeof ProviderCommandSchema>;
export type ProviderRuntimeSettings = z.infer<typeof ProviderRuntimeSettingsSchema>;
export type ProviderProfileModel = z.infer<typeof ProviderProfileModelSchema>;
export type ProviderOverride = z.infer<typeof ProviderOverrideSchema>;
export type AgentProviderRuntimeSettingsMap = Partial<
  Record<AgentProvider, ProviderRuntimeSettings>
>;

export type ProviderCommandPrefix = {
  command: string;
  args: string[];
};

export async function resolveProviderCommandPrefix(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string | Promise<string>,
): Promise<ProviderCommandPrefix> {
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: await resolveDefaultCommand(),
      args: [],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: await resolveDefaultCommand(),
      args: [...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0]!,
    args: commandConfig.argv.slice(1),
  };
}

let cachedShellEnv: Record<string, string> | null = null;

export function resolveShellEnv(): Record<string, string> {
  if (cachedShellEnv) {
    return cachedShellEnv;
  }
  cachedShellEnv = { ...process.env } as Record<string, string>;
  return cachedShellEnv;
}

export function migrateProviderSettings(
  raw: Record<string, unknown>,
  builtinProviderIds: string[],
): Record<string, ProviderOverride> {
  const migrated: Record<string, ProviderOverride> = {};
  const builtinProviderIdSet = new Set(builtinProviderIds);

  for (const [providerId, value] of Object.entries(raw)) {
    const parsedNew = ProviderOverrideSchema.safeParse(value);
    if (parsedNew.success) {
      migrated[providerId] = parsedNew.data;
      continue;
    }

    const parsedOld = ProviderRuntimeSettingsSchema.safeParse(value);
    if (!parsedOld.success) {
      continue;
    }

    const nextEntry: ProviderOverride = {};
    const command = parsedOld.data.command;
    if (command?.mode === "append") {
      console.warn(
        `[Config] Skipping legacy agents.providers.${providerId}.command append mode during provider override migration because it cannot be auto-migrated.`,
      );
      continue;
    }
    if (command?.mode === "replace") {
      nextEntry.command = command.argv;
    }
    if (parsedOld.data.env) {
      nextEntry.env = parsedOld.data.env;
    }
    if (!builtinProviderIdSet.has(providerId) && nextEntry.extends === undefined) {
      delete nextEntry.extends;
    }
    migrated[providerId] = nextEntry;
  }

  return migrated;
}

// Env vars that indicate a running Claude Code session. If the daemon itself is
// launched from inside Claude Code (e.g. by a Paseo agent), these leak into
// child processes and cause "cannot be launched inside another session" errors.
const PARENT_SESSION_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
];

export function applyProviderEnv(
  baseEnv: Record<string, string | undefined>,
  runtimeSettings?: ProviderRuntimeSettings,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {
    ...baseEnv,
    ...(runtimeSettings?.env ?? {}),
  };
  for (const key of PARENT_SESSION_ENV_VARS) {
    delete merged[key];
  }
  return merged;
}

export function findExecutable(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      const { existsSync } = require("node:fs");
      return existsSync(trimmed) ? trimmed : null;
    } catch {
      return null;
    }
  }
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const result = execFileSync(cmd, [trimmed], { encoding: "utf8" }).trim();
    const lines = result.split(/\r?\n/).filter((l: string) => l.trim());
    const candidate = lines.at(-1)?.trim() ?? null;
    return candidate && path.isAbsolute(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export async function isProviderCommandAvailable(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string | Promise<string>,
): Promise<boolean> {
  try {
    const prefix = await resolveProviderCommandPrefix(commandConfig, resolveDefaultCommand);
    return isCommandAvailable(prefix.command);
  } catch {
    return false;
  }
}
