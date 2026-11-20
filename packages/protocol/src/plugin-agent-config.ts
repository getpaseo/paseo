import { z } from "zod";

const selectorFields = {
  id: z.string().min(1).max(128),
  group: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
};
const baselineSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(256),
      kind: z.literal("absent"),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(256),
      kind: z.literal("value"),
      value: z.json(),
    })
    .strict(),
]);

export const LegacyAgentConfigRecipeSchema = z
  .object({
    version: z.literal(1),
    selectors: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({ ...selectorFields, kind: z.literal("mcp"), name: z.string().min(1).max(256) })
            .strict(),
          z
            .object({
              ...selectorFields,
              kind: z.literal("prompt-suffix"),
              text: z.string().min(1).max(16384),
              followedBySuffix: z.array(z.string().min(1).max(16384)).max(32).optional(),
            })
            .strict(),
          z
            .object({
              ...selectorFields,
              kind: z.literal("prompt-section"),
              start: z.string().min(1).max(16384),
              end: z.string().min(1).max(16384),
            })
            .strict(),
          z
            .object({
              ...selectorFields,
              kind: z.literal("grant"),
              server: z.string().min(1).max(256),
              tool: z.string().min(1).max(256),
            })
            .strict(),
          z
            .object({
              ...selectorFields,
              kind: z.literal("option"),
              key: z.string().min(1).max(256),
              baselines: z.array(baselineSchema).min(1).max(32),
            })
            .strict(),
          z
            .object({
              ...selectorFields,
              kind: z.literal("env"),
              key: z.string().min(1).max(256),
              baselines: z.array(baselineSchema).min(1).max(32),
            })
            .strict(),
        ]),
      )
      .max(256),
  })
  .strict();

export type LegacyAgentConfigRecipe = z.infer<typeof LegacyAgentConfigRecipeSchema>;
export type LegacyAgentConfigSelector = LegacyAgentConfigRecipe["selectors"][number];

export interface LegacyAgentConfigState {
  readonly selectors: Readonly<Record<string, "present" | "absent" | "ambiguous">>;
}

export const PluginConfigAdoptionSchema = z
  .object({
    id: z.string().min(1),
    pluginId: z.string().min(1),
    recipeDigest: z.string().min(1),
    selectorId: z.string().min(1),
    fragmentDigest: z.string().min(1),
    fragment: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("mcp"), name: z.string() }).strict(),
      z
        .object({
          kind: z.literal("prompt"),
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
          promptDigest: z.string(),
        })
        .strict(),
      z.object({ kind: z.literal("grant"), server: z.string(), tool: z.string() }).strict(),
      z.object({ kind: z.literal("option"), key: z.string(), baseline: baselineSchema }).strict(),
      z.object({ kind: z.literal("env"), key: z.string(), baseline: baselineSchema }).strict(),
    ]),
  })
  .strict();

export const PluginConfigAdoptionsSchema = z
  .object({
    version: z.literal(1),
    receipts: z.array(PluginConfigAdoptionSchema).max(256),
  })
  .strict();
export type PluginConfigAdoption = z.infer<typeof PluginConfigAdoptionSchema>;
export type PluginConfigAdoptions = z.infer<typeof PluginConfigAdoptionsSchema>;

export interface LegacyAgentConfigCandidate {
  id: string;
  pluginId: string;
  group: string;
  label: string;
  field: LegacyAgentConfigSelector["kind"];
  consequence: string;
  blockedReason?: string;
  baselines?: Array<{ id: string; label: string }>;
}

export interface LegacyAgentConfigPreview {
  expectedFingerprint: string;
  candidates: LegacyAgentConfigCandidate[];
  receiptIds: string[];
  warning?: string;
}

export interface LegacyAgentConfigSelection {
  id: string;
  baselineId?: string;
}

export interface LegacyAgentConfigMutationResult {
  receiptIds: string[];
  appliesOn: "next-open";
}

export const LegacyAgentConfigCandidateSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  group: z.string(),
  label: z.string(),
  field: z.enum(["mcp", "prompt-suffix", "prompt-section", "grant", "option", "env"]),
  consequence: z.string(),
  blockedReason: z.string().optional(),
  baselines: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
});

export const AgentPluginConfigPreviewRequestSchema = z.object({
  type: z.literal("agent.plugin_config.preview.request"),
  requestId: z.string(),
  agentId: z.string(),
  pluginId: z.string(),
  operation: z.enum(["adopt", "reset"]),
});
export const AgentPluginConfigApplyRequestSchema = z.object({
  type: z.literal("agent.plugin_config.apply.request"),
  requestId: z.string(),
  agentId: z.string(),
  pluginId: z.string(),
  expectedFingerprint: z.string(),
  selections: z
    .array(z.object({ id: z.string(), baselineId: z.string().optional() }).strict())
    .min(1)
    .max(256),
});
export const AgentPluginConfigResetRequestSchema = z.object({
  type: z.literal("agent.plugin_config.reset.request"),
  requestId: z.string(),
  agentId: z.string(),
  pluginId: z.string(),
  expectedFingerprint: z.string(),
  receiptIds: z.array(z.string()).min(1).max(256),
});
export const AgentPluginConfigPreviewResponseSchema = z.object({
  type: z.literal("agent.plugin_config.preview.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    error: z.string().nullable(),
    preview: z
      .object({
        expectedFingerprint: z.string(),
        candidates: z.array(LegacyAgentConfigCandidateSchema),
        receiptIds: z.array(z.string()),
        warning: z.string().optional(),
      })
      .nullable(),
  }),
});
const mutationPayloadSchema = z.object({
  requestId: z.string(),
  agentId: z.string(),
  error: z.string().nullable(),
  result: z
    .object({ receiptIds: z.array(z.string()), appliesOn: z.literal("next-open") })
    .nullable(),
});
export const AgentPluginConfigApplyResponseSchema = z.object({
  type: z.literal("agent.plugin_config.apply.response"),
  payload: mutationPayloadSchema,
});
export const AgentPluginConfigResetResponseSchema = z.object({
  type: z.literal("agent.plugin_config.reset.response"),
  payload: mutationPayloadSchema,
});

export const AgentTemplateGetRequestSchema = z.object({
  type: z.literal("agent.template.get.request"),
  requestId: z.string(),
  agentId: z.string(),
});
export const AgentTemplateGetResponseSchema = z.object({
  type: z.literal("agent.template.get.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    error: z.string().nullable(),
    template: z
      .object({
        provider: z.string(),
        cwd: z.string(),
        modeId: z.string().optional(),
        model: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        providerOptions: z.record(z.string(), z.unknown()).optional(),
      })
      .nullable(),
  }),
});
