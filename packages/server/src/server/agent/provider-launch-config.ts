import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";

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
  })
  .strict();

export const AgentProviderRuntimeSettingsMapSchema = z.record(
  AgentProviderSchema,
  ProviderRuntimeSettingsSchema
);

export type ProviderCommand = z.infer<typeof ProviderCommandSchema>;
export type ProviderRuntimeSettings = z.infer<typeof ProviderRuntimeSettingsSchema>;
export type AgentProviderRuntimeSettingsMap = Partial<
  Record<AgentProvider, ProviderRuntimeSettings>
>;

export type ProviderCommandPrefix = {
  command: string;
  args: string[];
};

export function resolveProviderCommandPrefix(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string
): ProviderCommandPrefix {
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: resolveDefaultCommand(),
      args: [],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: resolveDefaultCommand(),
      args: [...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0]!,
    args: commandConfig.argv.slice(1),
  };
}

export function applyProviderEnv(
  baseEnv: Record<string, string | undefined>,
  runtimeSettings?: ProviderRuntimeSettings
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    ...(runtimeSettings?.env ?? {}),
  };
}

export function isCommandAvailable(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    return existsSync(normalized);
  }

  try {
    const output = execFileSync("which", [normalized], { encoding: "utf8" }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

export function isProviderCommandAvailable(
  commandConfig: ProviderCommand | undefined,
  resolveDefaultCommand: () => string
): boolean {
  try {
    const prefix = resolveProviderCommandPrefix(commandConfig, resolveDefaultCommand);
    return isCommandAvailable(prefix.command);
  } catch {
    return false;
  }
}
