import { z } from "zod";

import { HubcodeCommandSchema } from "./types.js";

const baseResponseError = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

const CommandInstallStatusSchema = z.object({
  agentId: z.string(),
  agentActive: z.boolean(),
  status: z.enum(["installed", "not-installed", "unsupported", "disabled", "error"]),
  reason: z.string().optional(),
});

export const CommandWithStateSchema = z.object({
  definition: HubcodeCommandSchema,
  state: z.object({
    enabled: z.boolean(),
    installStatus: z.array(CommandInstallStatusSchema).optional(),
  }),
});

export const CommandsListRequestSchema = z.object({
  type: z.literal("commands/list"),
  requestId: z.string(),
});

export const CommandsListResponseSchema = z.object({
  type: z.literal("commands/list/response"),
  payload: baseResponseError.extend({
    commands: z.array(CommandWithStateSchema),
  }),
});

export const CommandsToggleRequestSchema = z.object({
  type: z.literal("commands/toggle"),
  requestId: z.string(),
  commandId: z.string(),
  enabled: z.boolean(),
});

export const CommandsToggleResponseSchema = z.object({
  type: z.literal("commands/toggle/response"),
  payload: baseResponseError.extend({
    commandId: z.string(),
    enabled: z.boolean(),
  }),
});

export const CommandsUpsertRequestSchema = z.object({
  type: z.literal("commands/upsert"),
  requestId: z.string(),
  command: HubcodeCommandSchema,
});

export const CommandsUpsertResponseSchema = z.object({
  type: z.literal("commands/upsert/response"),
  payload: baseResponseError.extend({
    commandId: z.string().nullable(),
  }),
});

export const CommandsDeleteRequestSchema = z.object({
  type: z.literal("commands/delete"),
  requestId: z.string(),
  commandId: z.string(),
});

export const CommandsDeleteResponseSchema = z.object({
  type: z.literal("commands/delete/response"),
  payload: baseResponseError.extend({
    commandId: z.string(),
  }),
});

export const CommandsChangedEventSchema = z.object({
  type: z.literal("commands/changed"),
  payload: z.object({
    commandId: z.string(),
  }),
});

export type CommandsListRequest = z.infer<typeof CommandsListRequestSchema>;
export type CommandsListResponse = z.infer<typeof CommandsListResponseSchema>;
export type CommandsToggleRequest = z.infer<typeof CommandsToggleRequestSchema>;
export type CommandsToggleResponse = z.infer<typeof CommandsToggleResponseSchema>;
export type CommandsUpsertRequest = z.infer<typeof CommandsUpsertRequestSchema>;
export type CommandsUpsertResponse = z.infer<typeof CommandsUpsertResponseSchema>;
export type CommandsDeleteRequest = z.infer<typeof CommandsDeleteRequestSchema>;
export type CommandsDeleteResponse = z.infer<typeof CommandsDeleteResponseSchema>;
export type CommandsChangedEvent = z.infer<typeof CommandsChangedEventSchema>;
export type CommandWithStateDto = z.infer<typeof CommandWithStateSchema>;
