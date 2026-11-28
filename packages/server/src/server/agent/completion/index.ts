import { z } from "zod";

export const AgentCompletionInputSchema = z.object({
  expectedTurnId: z.string().trim().min(1),
  reportReference: z.string().trim().min(1),
  decisionReference: z.string().trim().min(1),
});

export const AgentCompletionSchema = AgentCompletionInputSchema.extend({
  status: z.enum(["requested", "completed", "blocked", "superseded", "failed"]),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  reason: z.string().optional(),
  // Saved before closing, independently of provider history or best-effort timeline writes.
  finalReport: z.string().optional(),
});

export type AgentCompletion = z.infer<typeof AgentCompletionSchema>;
export type AgentCompletionInput = z.infer<typeof AgentCompletionInputSchema>;
