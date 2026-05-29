import { z } from "zod";
import {
  ScheduleCadenceSchema,
  ScheduleRunSchema,
  ScheduleSummarySchema,
  StoredScheduleSchema,
  ScheduleTargetSchema,
} from "./types.js";

const ScheduleCreateTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("self"),
    agentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("agent"),
    agentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("new-agent"),
    config: ScheduleTargetSchema.options[1].shape.config,
  }),
]);

export const ScheduleCreateRequestSchema = z.object({
  type: z.literal("schedule/create"),
  requestId: z.string(),
  prompt: z.string().min(1),
  name: z.string().optional(),
  cadence: ScheduleCadenceSchema,
  target: ScheduleCreateTargetSchema,
  maxRuns: z.number().int().positive().optional(),
  expiresAt: z.string().optional(),
  runOnCreate: z.boolean().optional(),
});

export const ScheduleListRequestSchema = z.object({
  type: z.literal("schedule/list"),
  requestId: z.string(),
});

export const ScheduleInspectRequestSchema = z.object({
  type: z.literal("schedule/inspect"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleLogsRequestSchema = z.object({
  type: z.literal("schedule/logs"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const SchedulePauseRequestSchema = z.object({
  type: z.literal("schedule/pause"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleResumeRequestSchema = z.object({
  type: z.literal("schedule/resume"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleDeleteRequestSchema = z.object({
  type: z.literal("schedule/delete"),
  requestId: z.string(),
  scheduleId: z.string(),
});

export const ScheduleRunOnceRequestSchema = z.object({
  type: z.literal("schedule/run-once"),
  requestId: z.string(),
  scheduleId: z.string(),
});

const ScheduleUpdateNewAgentConfigSchema = z.object({
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).nullable().optional(),
  modeId: z.string().trim().min(1).nullable().optional(),
  cwd: z.string().trim().min(1).optional(),
});

export const ScheduleUpdateRequestSchema = z.object({
  type: z.literal("schedule/update"),
  requestId: z.string(),
  scheduleId: z.string(),
  name: z.string().nullable().optional(),
  prompt: z.string().min(1).optional(),
  cadence: ScheduleCadenceSchema.optional(),
  newAgentConfig: ScheduleUpdateNewAgentConfigSchema.optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

export const ScheduleCreateResponseSchema = z.object({
  type: z.literal("schedule/create/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: ScheduleSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleListResponseSchema = z.object({
  type: z.literal("schedule/list/response"),
  payload: z.object({
    requestId: z.string(),
    schedules: z.array(ScheduleSummarySchema),
    error: z.string().nullable(),
  }),
});

export const ScheduleInspectResponseSchema = z.object({
  type: z.literal("schedule/inspect/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: StoredScheduleSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleLogsResponseSchema = z.object({
  type: z.literal("schedule/logs/response"),
  payload: z.object({
    requestId: z.string(),
    runs: z.array(ScheduleRunSchema),
    error: z.string().nullable(),
  }),
});

export const SchedulePauseResponseSchema = z.object({
  type: z.literal("schedule/pause/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: ScheduleSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleResumeResponseSchema = z.object({
  type: z.literal("schedule/resume/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: ScheduleSummarySchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleDeleteResponseSchema = z.object({
  type: z.literal("schedule/delete/response"),
  payload: z.object({
    requestId: z.string(),
    scheduleId: z.string(),
    error: z.string().nullable(),
  }),
});

export const ScheduleRunOnceResponseSchema = z.object({
  type: z.literal("schedule/run-once/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: StoredScheduleSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ScheduleUpdateResponseSchema = z.object({
  type: z.literal("schedule/update/response"),
  payload: z.object({
    requestId: z.string(),
    schedule: StoredScheduleSchema.nullable(),
    error: z.string().nullable(),
  }),
});
