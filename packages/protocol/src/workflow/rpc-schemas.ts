import { z } from "zod";
import {
  WorkflowEventRecordSchema,
  WorkflowRunDetailsSchema,
  WorkflowRunSummarySchema,
  WorkflowSpecSummarySchema,
  WorkflowValidationResultSchema,
} from "./types.js";

const WorkflowSpecObjectSchema = z.record(z.string(), z.unknown());
const WorkflowIdSchema = z.string().trim().min(1);
const WorkflowRunIdSchema = z.string().trim().min(1);

export const WorkflowSpecListRequestSchema = z.object({
  type: z.literal("workflow.spec.list.request"),
  requestId: z.string(),
});

export const WorkflowSpecGetRequestSchema = z.object({
  type: z.literal("workflow.spec.get.request"),
  requestId: z.string(),
  id: WorkflowIdSchema,
});

export const WorkflowSpecSaveRequestSchema = z.object({
  type: z.literal("workflow.spec.save.request"),
  requestId: z.string(),
  spec: WorkflowSpecObjectSchema,
});

export const WorkflowSpecValidateRequestSchema = z.object({
  type: z.literal("workflow.spec.validate.request"),
  requestId: z.string(),
  spec: WorkflowSpecObjectSchema,
});

export const WorkflowRunStartRequestSchema = z.object({
  type: z.literal("workflow.run.start.request"),
  requestId: z.string(),
  workflowId: WorkflowIdSchema,
  parameters: z.record(z.string(), z.unknown()).optional(),
  context: z
    .object({
      workspaceId: z.string().optional(),
      agentId: z.string().optional(),
    })
    .strict()
    .optional(),
});

export const WorkflowRunListRequestSchema = z.object({
  type: z.literal("workflow.run.list.request"),
  requestId: z.string(),
});

export const WorkflowRunInspectRequestSchema = z.object({
  type: z.literal("workflow.run.inspect.request"),
  requestId: z.string(),
  runId: WorkflowRunIdSchema,
});

export const WorkflowRunLogsRequestSchema = z.object({
  type: z.literal("workflow.run.logs.request"),
  requestId: z.string(),
  runId: WorkflowRunIdSchema,
  afterSeq: z.number().int().nonnegative().optional(),
});

export const WorkflowRunStopRequestSchema = z.object({
  type: z.literal("workflow.run.stop.request"),
  requestId: z.string(),
  runId: WorkflowRunIdSchema,
});

export const WorkflowRunResumeRequestSchema = z.object({
  type: z.literal("workflow.run.resume.request"),
  requestId: z.string(),
  runId: WorkflowRunIdSchema,
});

const WorkflowErrorSchema = z.string().nullable();

export const WorkflowSpecListResponseSchema = z.object({
  type: z.literal("workflow.spec.list.response"),
  payload: z.object({
    requestId: z.string(),
    specs: z.array(WorkflowSpecSummarySchema),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowSpecGetResponseSchema = z.object({
  type: z.literal("workflow.spec.get.response"),
  payload: z.object({
    requestId: z.string(),
    spec: WorkflowSpecObjectSchema.nullable(),
    summary: WorkflowSpecSummarySchema.nullable(),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowSpecSaveResponseSchema = z.object({
  type: z.literal("workflow.spec.save.response"),
  payload: z.object({
    requestId: z.string(),
    spec: WorkflowSpecObjectSchema.nullable(),
    summary: WorkflowSpecSummarySchema.nullable(),
    validation: WorkflowValidationResultSchema,
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowSpecValidateResponseSchema = z.object({
  type: z.literal("workflow.spec.validate.response"),
  payload: z.object({
    requestId: z.string(),
    validation: WorkflowValidationResultSchema,
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowRunStartResponseSchema = z.object({
  type: z.literal("workflow.run.start.response"),
  payload: z.object({
    requestId: z.string(),
    run: WorkflowRunSummarySchema.nullable(),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowRunListResponseSchema = z.object({
  type: z.literal("workflow.run.list.response"),
  payload: z.object({
    requestId: z.string(),
    runs: z.array(WorkflowRunSummarySchema),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowRunInspectResponseSchema = z.object({
  type: z.literal("workflow.run.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    details: WorkflowRunDetailsSchema.nullable(),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowRunLogsResponseSchema = z.object({
  type: z.literal("workflow.run.logs.response"),
  payload: z.object({
    requestId: z.string(),
    run: WorkflowRunSummarySchema.nullable(),
    entries: z.array(WorkflowEventRecordSchema),
    nextCursor: z.number().int().nonnegative(),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowRunStopResponseSchema = z.object({
  type: z.literal("workflow.run.stop.response"),
  payload: z.object({
    requestId: z.string(),
    run: WorkflowRunSummarySchema.nullable(),
    error: WorkflowErrorSchema,
  }),
});

export const WorkflowRunResumeResponseSchema = z.object({
  type: z.literal("workflow.run.resume.response"),
  payload: z.object({
    requestId: z.string(),
    run: WorkflowRunSummarySchema.nullable(),
    error: WorkflowErrorSchema,
  }),
});

export type WorkflowSpecListRequest = z.infer<typeof WorkflowSpecListRequestSchema>;
export type WorkflowSpecGetRequest = z.infer<typeof WorkflowSpecGetRequestSchema>;
export type WorkflowSpecSaveRequest = z.infer<typeof WorkflowSpecSaveRequestSchema>;
export type WorkflowSpecValidateRequest = z.infer<typeof WorkflowSpecValidateRequestSchema>;
export type WorkflowRunStartRequest = z.infer<typeof WorkflowRunStartRequestSchema>;
export type WorkflowRunListRequest = z.infer<typeof WorkflowRunListRequestSchema>;
export type WorkflowRunInspectRequest = z.infer<typeof WorkflowRunInspectRequestSchema>;
export type WorkflowRunLogsRequest = z.infer<typeof WorkflowRunLogsRequestSchema>;
export type WorkflowRunStopRequest = z.infer<typeof WorkflowRunStopRequestSchema>;
export type WorkflowRunResumeRequest = z.infer<typeof WorkflowRunResumeRequestSchema>;
export type WorkflowSpecListResponse = z.infer<typeof WorkflowSpecListResponseSchema>;
export type WorkflowSpecGetResponse = z.infer<typeof WorkflowSpecGetResponseSchema>;
export type WorkflowSpecSaveResponse = z.infer<typeof WorkflowSpecSaveResponseSchema>;
export type WorkflowSpecValidateResponse = z.infer<typeof WorkflowSpecValidateResponseSchema>;
export type WorkflowRunStartResponse = z.infer<typeof WorkflowRunStartResponseSchema>;
export type WorkflowRunListResponse = z.infer<typeof WorkflowRunListResponseSchema>;
export type WorkflowRunInspectResponse = z.infer<typeof WorkflowRunInspectResponseSchema>;
export type WorkflowRunLogsResponse = z.infer<typeof WorkflowRunLogsResponseSchema>;
export type WorkflowRunStopResponse = z.infer<typeof WorkflowRunStopResponseSchema>;
export type WorkflowRunResumeResponse = z.infer<typeof WorkflowRunResumeResponseSchema>;
