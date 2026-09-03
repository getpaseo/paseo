import { z } from "zod";

export const WatchdogJobIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
export const WatchdogJobStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export const WatchdogDeliveryStatusSchema = z.enum(["pending", "delivered"]);
export const WatchdogTerminationReasonSchema = z.enum(["cancelled", "timeout"]);

export const WatchdogStreamStatsSchema = z.object({
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const WatchdogResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable(),
  finishedAt: z.string(),
  terminationReason: WatchdogTerminationReasonSchema.optional(),
  // Optional bounded-stream metadata. Older workers omit these fields.
  stdout: WatchdogStreamStatsSchema.optional(),
  stderr: WatchdogStreamStatsSchema.optional(),
});

export const WatchdogJobSchema = z.object({
  id: WatchdogJobIdSchema,
  name: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  status: WatchdogJobStatusSchema,
  deliveryStatus: WatchdogDeliveryStatusSchema,
  workerPid: z.number().int().positive().nullable(),
  result: WatchdogResultSchema.nullable(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).nullable(),
  cancelRequestedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deliveredAt: z.string().nullable(),
});

export type WatchdogJob = z.infer<typeof WatchdogJobSchema>;
export type WatchdogResult = z.infer<typeof WatchdogResultSchema>;
export type WatchdogStreamStats = z.infer<typeof WatchdogStreamStatsSchema>;
