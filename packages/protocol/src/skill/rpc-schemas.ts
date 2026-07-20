import { z } from "zod";
import { SkillSchema, SkillCreateInputSchema, SkillUpdateInputSchema } from "./types.js";

const SkillResponsePayloadSchema = z.object({
  requestId: z.string(),
  skill: SkillSchema.nullable(),
  error: z.string().nullable(),
});

export const SkillListRequestSchema = z.object({
  type: z.literal("skill.list.request"),
  requestId: z.string(),
});

export const SkillListResponseSchema = z.object({
  type: z.literal("skill.list.response"),
  payload: z.object({
    requestId: z.string(),
    skills: z.array(SkillSchema),
    error: z.string().nullable(),
  }),
});

export const SkillCreateRequestSchema = z.object({
  type: z.literal("skill.create.request"),
  requestId: z.string(),
  skill: SkillCreateInputSchema,
});

export const SkillCreateResponseSchema = z.object({
  type: z.literal("skill.create.response"),
  payload: SkillResponsePayloadSchema,
});

export const SkillUpdateRequestSchema = z.object({
  type: z.literal("skill.update.request"),
  requestId: z.string(),
  skill: SkillUpdateInputSchema,
});

export const SkillUpdateResponseSchema = z.object({
  type: z.literal("skill.update.response"),
  payload: SkillResponsePayloadSchema,
});

export const SkillDeleteRequestSchema = z.object({
  type: z.literal("skill.delete.request"),
  requestId: z.string(),
  id: z.string().min(1),
});

export const SkillDeleteResponseSchema = z.object({
  type: z.literal("skill.delete.response"),
  payload: z.object({
    requestId: z.string(),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const SkillChangedMessageSchema = z.object({
  type: z.literal("skill.changed"),
  payload: z.object({
    skills: z.array(SkillSchema),
  }),
});
