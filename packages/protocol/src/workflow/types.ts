import { z } from "zod";

export const WorkflowSpecSourceSchema = z.enum(["built-in", "user", "legacy"]);

export const WorkflowSpecSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  source: WorkflowSpecSourceSchema,
  updatedAt: z.string().nullable(),
});

export const WorkflowValidationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const WorkflowValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
  summary: WorkflowSpecSummarySchema.nullable(),
  parameters: z.array(
    z.object({
      name: z.string(),
      type: z.enum([
        "string",
        "path",
        "image",
        "object",
        "array",
        "enum",
        "boolean",
        "integer",
        "number",
      ]),
      description: z.string(),
      required: z.boolean(),
      defaultValue: z.unknown().optional(),
      defaultFrom: z.enum(["current.workspace", "current.worktree", "current.agent"]).optional(),
      values: z.array(z.unknown()).optional(),
    }),
  ),
});

export const WorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "stopping",
  "stopped",
  "complete",
  "failed",
]);

export const WorkflowRunSummarySchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  status: WorkflowRunStatusSchema,
  reason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  iteration: z.number().int().nonnegative(),
  activeTurns: z.number().int().nonnegative(),
  legacy: z.boolean(),
  resumable: z.boolean(),
  workspaceIds: z.array(z.string()),
  agentIds: z.array(z.string()),
});

export const WorkflowEventRecordSchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  type: z.string(),
  instanceId: z.string().optional(),
  flow: z.string().optional(),
  state: z.string().optional(),
  agent: z.string().optional(),
  agentId: z.string().optional(),
  event: z.string().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const WorkflowRenderedPromptSchema = z.object({
  name: z.string(),
  workflowTurnId: z.string().nullable(),
  instanceId: z.string().nullable(),
  agentId: z.string().nullable(),
  createdAt: z.string().nullable(),
  content: z.string(),
});

export const WorkflowRunDetailsSchema = z.object({
  run: WorkflowRunSummarySchema,
  spec: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
  events: z.array(WorkflowEventRecordSchema),
  prompts: z.array(WorkflowRenderedPromptSchema),
});

export type WorkflowSpecSource = z.infer<typeof WorkflowSpecSourceSchema>;
export type WorkflowSpecSummary = z.infer<typeof WorkflowSpecSummarySchema>;
export type WorkflowValidationIssue = z.infer<typeof WorkflowValidationIssueSchema>;
export type WorkflowValidationResult = z.infer<typeof WorkflowValidationResultSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>;
export type WorkflowEventRecord = z.infer<typeof WorkflowEventRecordSchema>;
export type WorkflowRenderedPrompt = z.infer<typeof WorkflowRenderedPromptSchema>;
export type WorkflowRunDetails = z.infer<typeof WorkflowRunDetailsSchema>;
