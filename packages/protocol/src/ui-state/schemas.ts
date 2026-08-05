import { z } from "zod";

export const UiStateNamespaceSchema = z.enum(["composer", "review"]);
export type UiStateNamespace = z.infer<typeof UiStateNamespaceSchema>;

export const UiStateLifecycleSchema = z.enum(["active", "abandoned", "sent"]);
export type UiStateLifecycle = z.infer<typeof UiStateLifecycleSchema>;

export const UiStateReviewCommentSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  side: z.enum(["old", "new"]),
  lineNumber: z.number().int().nonnegative(),
  body: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type UiStateReviewComment = z.infer<typeof UiStateReviewCommentSchema>;

/**
 * Unified record shape for both namespaces.
 * Composer uses text/attachments/lifecycle; review uses comments.
 * Application code validates the active fields per namespace.
 */
export const UiStateRecordSchema = z.object({
  text: z.string().optional(),
  // Structural attachment metadata only; blob resolvability is not required on the wire.
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
  lifecycle: UiStateLifecycleSchema.optional(),
  comments: z.array(UiStateReviewCommentSchema).optional(),
  updatedAt: z.string().min(1),
});
export type UiStateRecord = z.infer<typeof UiStateRecordSchema>;

export const UiStateGetRequestMessageSchema = z.object({
  type: z.literal("ui_state.get.request"),
  requestId: z.string().min(1),
  namespace: UiStateNamespaceSchema,
  key: z.string().min(1),
});

export const UiStateGetResponseMessageSchema = z.object({
  type: z.literal("ui_state.get.response"),
  payload: z.object({
    requestId: z.string().min(1),
    namespace: UiStateNamespaceSchema,
    key: z.string().min(1),
    record: UiStateRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const UiStateUpsertRequestMessageSchema = z.object({
  type: z.literal("ui_state.upsert.request"),
  requestId: z.string().min(1),
  namespace: UiStateNamespaceSchema,
  key: z.string().min(1),
  record: UiStateRecordSchema,
});

export const UiStateUpsertResponseMessageSchema = z.object({
  type: z.literal("ui_state.upsert.response"),
  payload: z.object({
    requestId: z.string().min(1),
    namespace: UiStateNamespaceSchema,
    key: z.string().min(1),
    applied: z.boolean(),
    record: UiStateRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const UiStateClearRequestMessageSchema = z.object({
  type: z.literal("ui_state.clear.request"),
  requestId: z.string().min(1),
  namespace: UiStateNamespaceSchema,
  key: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const UiStateClearResponseMessageSchema = z.object({
  type: z.literal("ui_state.clear.response"),
  payload: z.object({
    requestId: z.string().min(1),
    namespace: UiStateNamespaceSchema,
    key: z.string().min(1),
    applied: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const UiStateListRequestMessageSchema = z.object({
  type: z.literal("ui_state.list.request"),
  requestId: z.string().min(1),
  namespace: UiStateNamespaceSchema,
  keyPrefix: z.string().optional(),
});

export const UiStateListEntrySchema = z.object({
  key: z.string().min(1),
  record: UiStateRecordSchema,
});

export const UiStateListResponseMessageSchema = z.object({
  type: z.literal("ui_state.list.response"),
  payload: z.object({
    requestId: z.string().min(1),
    namespace: UiStateNamespaceSchema,
    entries: z.array(UiStateListEntrySchema),
    error: z.string().nullable(),
  }),
});

/** Server → clients push after a successful upsert or clear. */
export const UiStateUpdatedMessageSchema = z.object({
  type: z.literal("ui_state.updated"),
  namespace: UiStateNamespaceSchema,
  key: z.string().min(1),
  record: UiStateRecordSchema.nullable(),
  updatedAt: z.string().min(1),
});

export type UiStateGetRequestMessage = z.infer<typeof UiStateGetRequestMessageSchema>;
export type UiStateGetResponseMessage = z.infer<typeof UiStateGetResponseMessageSchema>;
export type UiStateUpsertRequestMessage = z.infer<typeof UiStateUpsertRequestMessageSchema>;
export type UiStateUpsertResponseMessage = z.infer<typeof UiStateUpsertResponseMessageSchema>;
export type UiStateClearRequestMessage = z.infer<typeof UiStateClearRequestMessageSchema>;
export type UiStateClearResponseMessage = z.infer<typeof UiStateClearResponseMessageSchema>;
export type UiStateListRequestMessage = z.infer<typeof UiStateListRequestMessageSchema>;
export type UiStateListResponseMessage = z.infer<typeof UiStateListResponseMessageSchema>;
export type UiStateUpdatedMessage = z.infer<typeof UiStateUpdatedMessageSchema>;
