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
  input: planContext,
  output: z.object({
    type: z.literal("workflow.handoff.prepare.response"),
    recommendation: executorSelection.nullable(),
  }),
});
export const handoffRpc = defineRpc({
  name: "workflow.plan.handoff.request",
  // COMPAT(workflow-automatic-routing): added in v0.9.1, remove after 2027-09-15.
  // An already-loaded older client may still send its dropdown selection; the server ignores it.
  input: planContext.extend({ selection: executorSelection.optional() }),
  output: z.object({ type: z.literal("workflow.plan.handoff.response"), agentId: z.string() }),
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
    recommendation: executorSelection.nullable(),
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
