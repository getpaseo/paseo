import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const planContext = z.object({
  workspaceId: z.string(),
  agentId: z.string(),
  permissionRequestId: z.string(),
  callId: z.string(),
  text: z.string(),
});
export const executorSelection = z.enum(["standard", "advanced"]);
export const availablePlanContext = planContext.extend({
  permissionRequestId: z.string().optional(),
});
export const executionDecision = z.object({
  category: z.enum(["trivial", "bounded", "diagnostic", "complex", "critical"]),
  provider: z.literal("codex"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  reason: z.string().trim().min(1),
});
export const routingStatus = z.object({
  phase: z.enum(["running", "complete", "failed", "outcome_unknown"]),
  decision: executionDecision.optional(),
  error: z.string().optional(),
});
export const installRpc = defineRpc({
  name: "workflow.profiles.install.request",
  input: z.object({}),
  output: z.object({ type: z.literal("workflow.profiles.install.response"), count: z.number() }),
});
export const reviewRpc = defineRpc({
  name: "workflow.plan.review.request",
  input: planContext,
  output: z.object({ type: z.literal("workflow.plan.review.response"), agentId: z.string() }),
});
export const prepareRpc = defineRpc({
  name: "workflow.handoff.prepare.request",
  input: availablePlanContext,
  output: z.object({
    type: z.literal("workflow.handoff.prepare.response"),
    recommendation: executorSelection.nullable(),
  }),
});
export const enqueueRpc = defineRpc({
  name: "workflow.handoff.enqueue.request",
  input: planContext,
  output: z.object({
    type: z.literal("workflow.handoff.enqueue.response"),
    handoffRequested: z.boolean(),
  }),
});
export const handoffRpc = defineRpc({
  name: "workflow.plan.handoff.request",
  // COMPAT(workflow-automatic-routing): added in v0.9.1, remove after 2027-09-15.
  // An already-loaded older client may still send its dropdown selection; the server ignores it.
  input: planContext.extend({ selection: executorSelection.optional() }),
  output: z.object({ type: z.literal("workflow.plan.handoff.response"), agentId: z.string() }),
});
export const handoffToProfileRpc = defineRpc({
  name: "workflow.plan.handoff_to_profile.request",
  input: planContext.extend({ profileId: z.string().min(1) }),
  output: z.object({
    type: z.literal("workflow.plan.handoff_to_profile.response"),
    agentId: z.string(),
  }),
});
export const statusRpc = defineRpc({
  name: "workflow.status.get.request",
  input: z.object({ workspaceId: z.string(), agentId: z.string() }),
  output: z.object({
    type: z.literal("workflow.status.get.response"),
    verification: z
      .array(
        z.object({
          planId: z.string(),
          phase: z.literal("verification_required"),
          reason: z.string(),
        }),
      )
      .optional(),
    plan: planContext.nullable(),
    profiles: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    recommendation: executorSelection.nullable(),
    routing: routingStatus.nullable().optional(),
    handoffRequested: z.boolean().optional(),
    handoff: z
      .object({
        // COMPAT(workflow-executor-selection): added in v0.8.0, remove after 2027-09-13.
        selection: executorSelection.optional(),
        phase: z.enum(["closing", "closed", "running", "outcome_unknown"]),
        agentId: z.string().optional(),
      })
      .nullable()
      .optional(),
    reviews: z.array(
      z.object({
        planId: z.string(),
        phase: z.string(),
        reason: z.string().nullable(),
        managerId: z.string(),
      }),
    ),
  }),
});
