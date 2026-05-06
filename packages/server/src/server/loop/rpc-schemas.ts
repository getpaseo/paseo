import { z } from "zod";
import { AgentProviderSchema } from "../agent/provider-manifest.js";

export const LoopLogEntrySchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  iteration: z.number().int().positive().nullable(),
  source: z.enum(["loop", "worker", "verifier", "verify-check"]),
  level: z.enum(["info", "error"]),
  text: z.string(),
});

export const LoopVerifyCheckResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const LoopVerifyPromptResultSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  verifierAgentId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const LoopIterationRecordSchema = z.object({
  index: z.number().int().positive(),
  workerAgentId: z.string().nullable(),
  workerStartedAt: z.string(),
  workerCompletedAt: z.string().nullable(),
  verifierAgentId: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  workerOutcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  failureReason: z.string().nullable(),
  verifyChecks: z.array(LoopVerifyCheckResultSchema),
  verifyPrompt: LoopVerifyPromptResultSchema.nullable(),
});

export const LoopRecordSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string(),
  cwd: z.string(),
  provider: AgentProviderSchema,
  model: z.string().nullable(),
  modeId: z.string().nullable().default(null),
  workerProvider: AgentProviderSchema.nullable(),
  workerModel: z.string().nullable(),
  verifierProvider: AgentProviderSchema.nullable(),
  verifierModel: z.string().nullable(),
  verifierModeId: z.string().nullable().default(null),
  verifyPrompt: z.string().nullable(),
  verifyChecks: z.array(z.string()),
  archive: z.boolean(),
  sleepMs: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive().nullable(),
  maxTimeMs: z.number().int().positive().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  stopRequestedAt: z.string().nullable(),
  iterations: z.array(LoopIterationRecordSchema),
  logs: z.array(LoopLogEntrySchema),
  nextLogSeq: z.number().int().positive(),
  activeIteration: z.number().int().positive().nullable(),
  activeWorkerAgentId: z.string().nullable(),
  activeVerifierAgentId: z.string().nullable(),
});

export const LoopListItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  cwd: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activeIteration: z.number().int().positive().nullable(),
});

export const LoopRunRequestSchema = z.object({
  type: z.literal("loop/run"),
  requestId: z.string(),
  prompt: z.string().trim().min(1),
  cwd: z.string(),
  provider: AgentProviderSchema.optional(),
  model: z.string().trim().min(1).optional(),
  modeId: z.string().trim().min(1).optional(),
  workerProvider: AgentProviderSchema.optional(),
  workerModel: z.string().trim().min(1).optional(),
  verifierProvider: AgentProviderSchema.optional(),
  verifierModel: z.string().trim().min(1).optional(),
  verifierModeId: z.string().trim().min(1).optional(),
  verifyPrompt: z.string().trim().min(1).optional(),
  verifyChecks: z.array(z.string().trim().min(1)).optional(),
  archive: z.boolean().optional(),
  name: z.string().trim().min(1).optional(),
  sleepMs: z.number().int().nonnegative().optional(),
  maxIterations: z.number().int().positive().optional(),
  maxTimeMs: z.number().int().positive().optional(),
});

export const LoopListRequestSchema = z.object({
  type: z.literal("loop/list"),
  requestId: z.string(),
});

export const LoopInspectRequestSchema = z.object({
  type: z.literal("loop/inspect"),
  requestId: z.string(),
  id: z.string().trim().min(1),
});

export const LoopLogsRequestSchema = z.object({
  type: z.literal("loop/logs"),
  requestId: z.string(),
  id: z.string().trim().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
});

export const LoopStopRequestSchema = z.object({
  type: z.literal("loop/stop"),
  requestId: z.string(),
  id: z.string().trim().min(1),
});

export const LoopRunResponseSchema = z.object({
  type: z.literal("loop/run/response"),
  payload: z.object({
    requestId: z.string(),
    loop: LoopRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LoopListResponseSchema = z.object({
  type: z.literal("loop/list/response"),
  payload: z.object({
    requestId: z.string(),
    loops: z.array(LoopListItemSchema),
    error: z.string().nullable(),
  }),
});

export const LoopInspectResponseSchema = z.object({
  type: z.literal("loop/inspect/response"),
  payload: z.object({
    requestId: z.string(),
    loop: LoopRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const LoopLogsResponseSchema = z.object({
  type: z.literal("loop/logs/response"),
  payload: z.object({
    requestId: z.string(),
    loop: LoopRecordSchema.nullable(),
    entries: z.array(LoopLogEntrySchema),
    nextCursor: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }),
});

export const LoopStopResponseSchema = z.object({
  type: z.literal("loop/stop/response"),
  payload: z.object({
    requestId: z.string(),
    loop: LoopRecordSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export type LoopLogEntry = z.infer<typeof LoopLogEntrySchema>;
export type LoopVerifyCheckResult = z.infer<typeof LoopVerifyCheckResultSchema>;
export type LoopVerifyPromptResult = z.infer<typeof LoopVerifyPromptResultSchema>;
export type LoopIterationRecord = z.infer<typeof LoopIterationRecordSchema>;
export type LoopRecord = z.infer<typeof LoopRecordSchema>;
export type LoopListItem = z.infer<typeof LoopListItemSchema>;
export type LoopRunRequest = z.infer<typeof LoopRunRequestSchema>;
export type LoopListRequest = z.infer<typeof LoopListRequestSchema>;
export type LoopInspectRequest = z.infer<typeof LoopInspectRequestSchema>;
export type LoopLogsRequest = z.infer<typeof LoopLogsRequestSchema>;
export type LoopStopRequest = z.infer<typeof LoopStopRequestSchema>;
export type LoopRunResponse = z.infer<typeof LoopRunResponseSchema>;
export type LoopListResponse = z.infer<typeof LoopListResponseSchema>;
export type LoopInspectResponse = z.infer<typeof LoopInspectResponseSchema>;
export type LoopLogsResponse = z.infer<typeof LoopLogsResponseSchema>;
export type LoopStopResponse = z.infer<typeof LoopStopResponseSchema>;
