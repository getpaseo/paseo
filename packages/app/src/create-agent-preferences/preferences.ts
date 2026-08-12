import { z } from "zod";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

const featureValuesSchema = z.record(z.string(), z.union([z.boolean(), z.string(), z.null()]));

export interface ProviderPreferences {
  model?: string;
  mode?: string;
  thinkingByModel?: Record<string, string>;
  featureValues?: Record<string, unknown>;
}

export type LaunchTarget = { kind: "chat" } | { kind: "terminal"; profileId: string };

export interface FormPreferences {
  provider?: string;
  providerPreferences?: Record<string, ProviderPreferences>;
  favoriteModels?: Array<{ provider: string; modelId: string }>;
  isolation?: "local" | "worktree";
  launchTarget?: LaunchTarget;
}

interface LegacyLocationFormPreferences {
  workingDir?: string;
  provider?: string;
  serverId?: string;
}

const providerPreferencesSchema: z.ZodType<ProviderPreferences> = z.strictObject({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingByModel: z.record(z.string(), z.string()).optional(),
  featureValues: featureValuesSchema.optional(),
});

const launchTargetSchema: z.ZodType<LaunchTarget> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat") }),
  z.strictObject({ kind: z.literal("terminal"), profileId: z.string() }),
]);

export const FormPreferencesSchema: z.ZodType<FormPreferences> = z.strictObject({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  // COMPAT(agentProfileFavoriteMigration): favourites were removed in v0.3.2.
  // Keep the legacy payload alive until every capable host has had a chance to
  // import it; ordinary preference writes must not erase it first.
  favoriteModels: z
    .array(
      z.strictObject({
        provider: z.string(),
        modelId: z.string(),
      }),
    )
    .optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  // What the New workspace composer submits to: the chat agent (default) or a
  // terminal profile. See `@/new-workspace-launch` for resolution/fallback.
  launchTarget: launchTargetSchema.optional(),
});

const LegacyLocationFormPreferencesSchema: z.ZodType<LegacyLocationFormPreferences> =
  z.strictObject({
    workingDir: z.string().optional(),
    provider: z.string().optional(),
    serverId: z.string().optional(),
  });

export const StoredFormPreferencesSchema: z.ZodType<FormPreferences> = z.union([
  FormPreferencesSchema,
  LegacyLocationFormPreferencesSchema.transform(({ provider }) =>
    provider === undefined ? {} : { provider },
  ),
]);

export const DEFAULT_FORM_PREFERENCES: FormPreferences = {};

export function parseFormPreferences(value: unknown): FormPreferences {
  const result = StoredFormPreferencesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_FORM_PREFERENCES;
}

function mergeDefinedRecord<T>(
  existing: Record<string, T> | undefined,
  updates: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (updates === undefined) {
    return existing;
  }
  return {
    ...existing,
    ...updates,
  };
}

function applyProviderPreferenceUpdates(
  existing: ProviderPreferences,
  updates: Partial<ProviderPreferences>,
): ProviderPreferences {
  const next: ProviderPreferences = { ...existing };
  const nextThinkingByModel = mergeDefinedRecord(existing.thinkingByModel, updates.thinkingByModel);
  const nextFeatureValues = mergeDefinedRecord(existing.featureValues, updates.featureValues);

  if (updates.model !== undefined) {
    next.model = updates.model;
  }
  if (updates.mode !== undefined) {
    next.mode = updates.mode;
  }
  if (nextThinkingByModel !== undefined) {
    next.thinkingByModel = nextThinkingByModel;
  }
  if (nextFeatureValues !== undefined) {
    next.featureValues = nextFeatureValues;
  }

  return next;
}

export function mergeProviderPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Partial<ProviderPreferences>;
}): FormPreferences {
  const { preferences, provider, updates } = args;
  const existingProviderPreferences = preferences.providerPreferences ?? {};
  const existing = existingProviderPreferences[provider] ?? {};

  return {
    ...preferences,
    provider,
    providerPreferences: {
      ...existingProviderPreferences,
      [provider]: applyProviderPreferenceUpdates(existing, updates),
    },
  };
}

export function mergeCreateAgentSelectionPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider | null;
  modelId?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
}): FormPreferences {
  if (!args.provider) {
    return args.preferences;
  }

  const modelId = args.modelId?.trim() ?? "";
  const modeId = args.modeId?.trim() ?? "";
  const thinkingOptionId = args.thinkingOptionId?.trim() ?? "";
  const featureValues = featureValuesSchema.safeParse(args.featureValues);

  return mergeProviderPreferences({
    preferences: args.preferences,
    provider: args.provider,
    updates: {
      model: modelId || undefined,
      mode: modeId || undefined,
      ...(modelId && thinkingOptionId ? { thinkingByModel: { [modelId]: thinkingOptionId } } : {}),
      ...(featureValues.success ? { featureValues: featureValues.data } : {}),
    },
  });
}
