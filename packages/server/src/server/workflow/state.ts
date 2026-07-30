import { z } from "zod";

export const WorkflowWorkspaceSchema = z.object({
  workspaceId: z.string(),
  cwd: z.string(),
  name: z.string().optional(),
  branch: z.string().optional(),
  head: z.string().optional(),
});

export const WorkflowAcceptedEventSchema = z.object({
  event: z.string(),
  message: z.string(),
  data: z.unknown(),
  acceptedAt: z.string(),
  nativeTurnId: z.string(),
});

export const WorkflowActiveTurnSchema = z.object({
  workflowTurnId: z.string(),
  clientMessageId: z.string(),
  iteration: z.number().int().positive(),
  instanceId: z.string(),
  flow: z.string(),
  state: z.string(),
  agent: z.string(),
  prompt: z.string(),
  promptPath: z.string(),
  attempt: z.number().int().positive(),
  phase: z.enum(["queued", "launching", "running"]),
  agentId: z.string().nullable(),
  nativeTurnId: z.string().nullable(),
  allowedEvents: z.array(z.string()),
  acceptedEvent: WorkflowAcceptedEventSchema.nullable(),
  createdAt: z.string(),
});

export const WorkflowCompletedTurnSchema = z.object({
  workflowTurnId: z.string(),
  clientMessageId: z.string(),
  nativeTurnId: z.string().nullable(),
  iteration: z.number().int().positive(),
  attempt: z.number().int().positive(),
  instanceId: z.string(),
  flow: z.string(),
  state: z.string(),
  agent: z.string(),
  agentId: z.string(),
  status: z.enum(["completed", "failed", "canceled"]),
  lastMessage: z.string(),
  lastError: z.string().nullable(),
  promptPath: z.string(),
  emission: WorkflowAcceptedEventSchema.nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const WorkflowRoleStateSchema = z.object({
  agentId: z.string().nullable(),
  status: z.enum(["idle", "running", "completed", "failed", "canceled"]),
  lastMessage: z.string(),
  turns: z.array(WorkflowCompletedTurnSchema),
});

export const WorkflowInstanceSchema = z.object({
  id: z.string(),
  flow: z.string(),
  state: z.string(),
  status: z.enum([
    "provisioning",
    "runnable",
    "waiting-turn",
    "waiting-call",
    "waiting-map",
    "returned",
    "complete",
  ]),
  inputs: z.record(z.string(), z.unknown()),
  incoming: z.object({ event: z.string(), message: z.string(), data: z.unknown() }),
  workspace: WorkflowWorkspaceSchema.nullable(),
  workspaceRequest: z.record(z.string(), z.unknown()).nullable(),
  agents: z.record(z.string(), WorkflowRoleStateSchema),
  activeTurn: WorkflowActiveTurnSchema.nullable(),
  parent: z.record(z.string(), z.unknown()).nullable(),
  waiting: z.record(z.string(), z.unknown()).nullable(),
  groups: z.record(z.string(), z.record(z.string(), z.unknown())),
  task: z.record(z.string(), z.unknown()).nullable(),
  result: z.unknown(),
  repair: z
    .object({
      agentId: z.string(),
      attempt: z.number().int().positive(),
      reason: z.string(),
    })
    .nullable(),
});

export const WorkflowRunStateSchema = z.object({
  schemaVersion: z.literal("paseo.workflows.run.v0.2"),
  runId: z.string(),
  workflow: z.object({ id: z.string(), name: z.string() }),
  status: z.enum(["queued", "running", "stopping", "stopped", "complete", "failed"]),
  reason: z.string().nullable(),
  stopRequested: z.boolean(),
  pendingTerminal: z
    .object({
      status: z.enum(["complete", "stopped", "failed"]),
      reason: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  loop: z.object({
    iteration: z.number().int().nonnegative(),
    elapsedSeconds: z.number().int().nonnegative(),
  }),
  eventSeq: z.number().int().nonnegative(),
  nextInstance: z.number().int().positive(),
  instances: z.record(z.string(), WorkflowInstanceSchema),
  result: z.unknown(),
});

export type WorkflowWorkspace = z.infer<typeof WorkflowWorkspaceSchema>;
export type WorkflowAcceptedEvent = z.infer<typeof WorkflowAcceptedEventSchema>;
export type WorkflowActiveTurn = z.infer<typeof WorkflowActiveTurnSchema>;
export type WorkflowCompletedTurn = z.infer<typeof WorkflowCompletedTurnSchema>;
export type WorkflowRoleState = z.infer<typeof WorkflowRoleStateSchema>;
export type WorkflowInstance = z.infer<typeof WorkflowInstanceSchema>;
export type WorkflowRunState = z.infer<typeof WorkflowRunStateSchema>;
