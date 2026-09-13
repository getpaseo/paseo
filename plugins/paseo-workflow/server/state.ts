import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { planContext, executorSelection } from "../shared/rpc";
import { classification, auditDecision } from "../shared/final-review";

const finalReview = z.object({
  phase: z.enum([
    "classifying",
    "auditing",
    "deciding",
    "correcting",
    "delta",
    "committing",
    "complete",
    "verification_required",
  ]),
  managerId: z.string(),
  head: z.string(),
  diff: z.string(),
  dirtyFiles: z.array(z.string()),
  ambiguousWorkingTree: z.boolean().optional(),
  classification: classification.optional(),
  audits: z.record(z.string(), z.object({ agentId: z.string(), result: auditDecision.optional() })),
  validationCommands: z.array(z.string()).optional(),
  correctionDiff: z.string().optional(),
  deltaId: z.string().optional(),
  reason: z.string().optional(),
});
export const workflowSettings = defineSettings({
  id: "workflows",
  scope: "host",
  version: 1,
  schema: z.object({
    workflows: z
      .record(
        z.string(),
        z.object({
          id: z.string(),
          workspaceId: z.string(),
          plannerId: z.string(),
          routerId: z.string().optional(),
          routed: z.boolean().optional(),
          activePlanId: z.string().optional(),
          preparedPlanId: z.string().optional(),
          handledTurns: z.record(z.string(), z.string()).optional(),
          plannerTranscript: z
            .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }))
            .optional(),
          intent: z.string(),
          request: z.string(),
          constraints: z.array(z.string()),
          assumptions: z.array(z.string()),
          git: z.object({
            // COMPAT(workflow-start-head): added in v0.8.0, remove after 2027-09-13.
            base: z.string().optional(),
            startHead: z.string().optional(),
            targetBase: z.string().optional(),
            targetRef: z.string().optional(),
            branch: z.string(),
            dirty: z.string(),
          }),
          recommendation: executorSelection.nullable(),
          plans: z.record(
            z.string(),
            z.object({
              context: planContext,
              approved: z.boolean().optional(),
              verification: z.string().optional(),
              final: finalReview.optional(),
              review: z
                .object({
                  source: z.enum(["automatic", "manual"]),
                  phase: z.enum(["closing", "closed", "running", "complete", "outcome_unknown"]),
                  agentId: z.string().optional(),
                  promptSent: z.boolean().optional(),
                  superseded: z.boolean().optional(),
                })
                .optional(),
              handoff: z
                .object({
                  selection: executorSelection,
                  phase: z.enum(["closing", "closed", "running"]),
                  agentId: z.string().optional(),
                })
                .optional(),
            }),
          ),
        }),
      )
      .default({}),
  }),
});
