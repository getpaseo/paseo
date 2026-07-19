import { z } from "zod";
import {
  AssistantCreateInputSchema,
  AssistantSchema,
  AssistantUpdateInputSchema,
} from "./types.js";

const AssistantResponsePayloadSchema = z.object({
  requestId: z.string(),
  assistant: AssistantSchema.nullable(),
  error: z.string().nullable(),
});

export const AssistantListRequestSchema = z.object({
  type: z.literal("assistant.list.request"),
  requestId: z.string(),
});

export const AssistantListResponseSchema = z.object({
  type: z.literal("assistant.list.response"),
  payload: z.object({
    requestId: z.string(),
    assistants: z.array(AssistantSchema),
    error: z.string().nullable(),
  }),
});

export const AssistantCreateRequestSchema = z.object({
  type: z.literal("assistant.create.request"),
  requestId: z.string(),
  assistant: AssistantCreateInputSchema,
});

export const AssistantCreateResponseSchema = z.object({
  type: z.literal("assistant.create.response"),
  payload: AssistantResponsePayloadSchema,
});

export const AssistantUpdateRequestSchema = z.object({
  type: z.literal("assistant.update.request"),
  requestId: z.string(),
  assistant: AssistantUpdateInputSchema,
});

export const AssistantUpdateResponseSchema = z.object({
  type: z.literal("assistant.update.response"),
  payload: AssistantResponsePayloadSchema,
});

export const AssistantDeleteRequestSchema = z.object({
  type: z.literal("assistant.delete.request"),
  requestId: z.string(),
  id: z.string().min(1),
});

export const AssistantDeleteResponseSchema = z.object({
  type: z.literal("assistant.delete.response"),
  payload: z.object({
    requestId: z.string(),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const AssistantChangedMessageSchema = z.object({
  type: z.literal("assistant.changed"),
  payload: z.object({
    assistants: z.array(AssistantSchema),
  }),
});
