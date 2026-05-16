import { z } from "zod";
import type { AgentProvider } from "./agent-types.js";
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
    additionalModels: z.array(ProviderProfileModelSchema).optional(),
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
