import { z } from "zod";
import {
  TeamSchema,
  TeamCreateInputSchema,
  TeamUpdateInputSchema,
  TeamSlotWorkSchema,
} from "./types.js";

const TeamResponsePayloadSchema = z.object({
  requestId: z.string(),
  team: TeamSchema.nullable(),
  error: z.string().nullable(),
});

export const TeamListRequestSchema = z.object({
  type: z.literal("team.list.request"),
  requestId: z.string(),
});

export const TeamListResponseSchema = z.object({
  type: z.literal("team.list.response"),
  payload: z.object({
    requestId: z.string(),
    teams: z.array(TeamSchema),
    error: z.string().nullable(),
  }),
});

export const TeamCreateRequestSchema = z.object({
  type: z.literal("team.create.request"),
  requestId: z.string(),
  team: TeamCreateInputSchema,
});

export const TeamCreateResponseSchema = z.object({
  type: z.literal("team.create.response"),
  payload: TeamResponsePayloadSchema,
});

export const TeamUpdateRequestSchema = z.object({
  type: z.literal("team.update.request"),
  requestId: z.string(),
  team: TeamUpdateInputSchema,
});

export const TeamUpdateResponseSchema = z.object({
  type: z.literal("team.update.response"),
  payload: TeamResponsePayloadSchema,
});

export const TeamDeleteRequestSchema = z.object({
  type: z.literal("team.delete.request"),
  requestId: z.string(),
  id: z.string().min(1),
});

export const TeamDeleteResponseSchema = z.object({
  type: z.literal("team.delete.response"),
  payload: z.object({
    requestId: z.string(),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const TeamGetRequestSchema = z.object({
  type: z.literal("team.get.request"),
  requestId: z.string(),
  id: z.string().min(1),
});

export const TeamGetResponseSchema = z.object({
  type: z.literal("team.get.response"),
  payload: TeamResponsePayloadSchema,
});

export const TeamChangedMessageSchema = z.object({
  type: z.literal("team.changed"),
  payload: z.object({
    teams: z.array(TeamSchema),
  }),
});

export const TeamSendRunRequestSchema = z.object({
  type: z.literal("team.send_run.request"),
  requestId: z.string(),
  teamId: z.string().min(1),
  input: z.string(),
  slotId: z.string().optional(),
});

export const TeamSendRunResponseSchema = z.object({
  type: z.literal("team.send_run.response"),
  payload: z.object({
    requestId: z.string(),
    runId: z.string().nullable(),
    slotWork: z.array(TeamSlotWorkSchema),
    error: z.string().nullable(),
  }),
});

export const TeamRunStateRequestSchema = z.object({
  type: z.literal("team.run_state.request"),
  requestId: z.string(),
  teamId: z.string().min(1),
});

export const TeamRunStateResponseSchema = z.object({
  type: z.literal("team.run_state.response"),
  payload: z.object({
    requestId: z.string(),
    activeRunId: z.string().nullable(),
    slotWork: z.array(TeamSlotWorkSchema),
    error: z.string().nullable(),
  }),
});
