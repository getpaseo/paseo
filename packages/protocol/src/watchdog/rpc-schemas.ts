import { z } from "zod";

import { WatchdogJobIdSchema, WatchdogJobSchema } from "./types.js";

export const WatchdogStartRequestSchema = z.object({
  type: z.literal("watchdog.start.request"),
  requestId: z.string(),
  name: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  cwd: z.string().trim().min(1),
  command: z.string().trim().min(1),
  // Optional on the wire; normalize to [] after validation.
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
});

export const WatchdogListRequestSchema = z.object({
  type: z.literal("watchdog.list.request"),
  requestId: z.string(),
  agentId: z.string().trim().min(1).optional(),
});

export const WatchdogInspectRequestSchema = z.object({
  type: z.literal("watchdog.inspect.request"),
  requestId: z.string(),
  jobId: WatchdogJobIdSchema,
});

export const WatchdogCancelRequestSchema = z.object({
  type: z.literal("watchdog.cancel.request"),
  requestId: z.string(),
  jobId: WatchdogJobIdSchema,
});

export const WatchdogStartResponseSchema = z.object({
  type: z.literal("watchdog.start.response"),
  payload: z.object({
    requestId: z.string(),
    job: WatchdogJobSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const WatchdogListResponseSchema = z.object({
  type: z.literal("watchdog.list.response"),
  payload: z.object({
    requestId: z.string(),
    jobs: z.array(WatchdogJobSchema),
    error: z.string().nullable(),
  }),
});

export const WatchdogInspectResponseSchema = z.object({
  type: z.literal("watchdog.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    job: WatchdogJobSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const WatchdogCancelResponseSchema = z.object({
  type: z.literal("watchdog.cancel.response"),
  payload: z.object({
    requestId: z.string(),
    job: WatchdogJobSchema.nullable(),
    error: z.string().nullable(),
  }),
});
