import { z } from "zod";

import { HubcodeRuleSchema } from "./types.js";

const baseResponseError = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

const RuleInstallStatusSchema = z.object({
  agentId: z.string(),
  agentActive: z.boolean(),
  status: z.enum(["installed", "not-installed", "unsupported", "disabled", "error"]),
  reason: z.string().optional(),
});

export const RuleWithStateSchema = z.object({
  definition: HubcodeRuleSchema,
  state: z.object({
    enabled: z.boolean(),
    installStatus: z.array(RuleInstallStatusSchema).optional(),
  }),
});

export const RulesListRequestSchema = z.object({
  type: z.literal("rules/list"),
  requestId: z.string(),
});

export const RulesListResponseSchema = z.object({
  type: z.literal("rules/list/response"),
  payload: baseResponseError.extend({
    rules: z.array(RuleWithStateSchema),
  }),
});

export const RulesToggleRequestSchema = z.object({
  type: z.literal("rules/toggle"),
  requestId: z.string(),
  ruleId: z.string(),
  enabled: z.boolean(),
});

export const RulesToggleResponseSchema = z.object({
  type: z.literal("rules/toggle/response"),
  payload: baseResponseError.extend({
    ruleId: z.string(),
    enabled: z.boolean(),
  }),
});

export const RulesUpsertRequestSchema = z.object({
  type: z.literal("rules/upsert"),
  requestId: z.string(),
  rule: HubcodeRuleSchema,
});

export const RulesUpsertResponseSchema = z.object({
  type: z.literal("rules/upsert/response"),
  payload: baseResponseError.extend({
    ruleId: z.string().nullable(),
  }),
});

export const RulesDeleteRequestSchema = z.object({
  type: z.literal("rules/delete"),
  requestId: z.string(),
  ruleId: z.string(),
});

export const RulesDeleteResponseSchema = z.object({
  type: z.literal("rules/delete/response"),
  payload: baseResponseError.extend({
    ruleId: z.string(),
  }),
});

export const RulesChangedEventSchema = z.object({
  type: z.literal("rules/changed"),
  payload: z.object({ ruleId: z.string() }),
});

export type RulesListRequest = z.infer<typeof RulesListRequestSchema>;
export type RulesListResponse = z.infer<typeof RulesListResponseSchema>;
export type RulesToggleRequest = z.infer<typeof RulesToggleRequestSchema>;
export type RulesToggleResponse = z.infer<typeof RulesToggleResponseSchema>;
export type RulesUpsertRequest = z.infer<typeof RulesUpsertRequestSchema>;
export type RulesUpsertResponse = z.infer<typeof RulesUpsertResponseSchema>;
export type RulesDeleteRequest = z.infer<typeof RulesDeleteRequestSchema>;
export type RulesDeleteResponse = z.infer<typeof RulesDeleteResponseSchema>;
export type RulesChangedEvent = z.infer<typeof RulesChangedEventSchema>;
export type RuleWithStateDto = z.infer<typeof RuleWithStateSchema>;
