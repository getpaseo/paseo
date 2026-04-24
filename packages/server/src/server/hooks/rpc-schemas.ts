import { z } from "zod";

import { HubcodeHookSchema } from "./types.js";

const baseResponseError = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

/** hooks/list → returns the full registry (builtins + user). */
export const HooksListRequestSchema = z.object({
  type: z.literal("hooks/list"),
  requestId: z.string(),
});

export const HookWithStateSchema = z.object({
  definition: HubcodeHookSchema,
  state: z.object({
    enabled: z.boolean(),
    lastFiredAt: z.string().optional(),
    firedCount: z.number().int().nonnegative().optional(),
  }),
});

export const HooksListResponseSchema = z.object({
  type: z.literal("hooks/list/response"),
  payload: baseResponseError.extend({
    hooks: z.array(HookWithStateSchema),
  }),
});

/** hooks/toggle → flip enabled state. */
export const HooksToggleRequestSchema = z.object({
  type: z.literal("hooks/toggle"),
  requestId: z.string(),
  hookId: z.string(),
  enabled: z.boolean(),
});

export const HooksToggleResponseSchema = z.object({
  type: z.literal("hooks/toggle/response"),
  payload: baseResponseError.extend({
    hookId: z.string(),
    enabled: z.boolean(),
  }),
});

/** hooks/upsert → create or update a user-authored hook. */
export const HooksUpsertRequestSchema = z.object({
  type: z.literal("hooks/upsert"),
  requestId: z.string(),
  hook: HubcodeHookSchema,
});

export const HooksUpsertResponseSchema = z.object({
  type: z.literal("hooks/upsert/response"),
  payload: baseResponseError.extend({
    hookId: z.string().nullable(),
  }),
});

/** hooks/delete → remove a user-authored hook. */
export const HooksDeleteRequestSchema = z.object({
  type: z.literal("hooks/delete"),
  requestId: z.string(),
  hookId: z.string(),
});

export const HooksDeleteResponseSchema = z.object({
  type: z.literal("hooks/delete/response"),
  payload: baseResponseError.extend({
    hookId: z.string(),
  }),
});

/** Push event broadcast when any hook state changes. */
export const HooksChangedEventSchema = z.object({
  type: z.literal("hooks/changed"),
  payload: z.object({
    hookId: z.string(),
  }),
});

export type HooksListRequest = z.infer<typeof HooksListRequestSchema>;
export type HooksListResponse = z.infer<typeof HooksListResponseSchema>;
export type HooksToggleRequest = z.infer<typeof HooksToggleRequestSchema>;
export type HooksToggleResponse = z.infer<typeof HooksToggleResponseSchema>;
export type HooksUpsertRequest = z.infer<typeof HooksUpsertRequestSchema>;
export type HooksUpsertResponse = z.infer<typeof HooksUpsertResponseSchema>;
export type HooksDeleteRequest = z.infer<typeof HooksDeleteRequestSchema>;
export type HooksDeleteResponse = z.infer<typeof HooksDeleteResponseSchema>;
export type HooksChangedEvent = z.infer<typeof HooksChangedEventSchema>;
export type HookWithStateDto = z.infer<typeof HookWithStateSchema>;
