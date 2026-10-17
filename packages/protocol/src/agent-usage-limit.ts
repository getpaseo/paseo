import { z } from "zod";

export const AUTO_RESUME_USAGE_LIMIT_LABEL = "paseo.auto-resume-usage-limit";
export const USAGE_LIMIT_RESUME_DELAY_MS = 60_000;

export const AgentUsageLimitSchema = z.object({
  resetsAt: z.string().nullable(),
});

export type AgentUsageLimit = z.infer<typeof AgentUsageLimitSchema>;

export function usageLimitResumeAt(limit: AgentUsageLimit): number | null {
  if (limit.resetsAt === null) return null;
  const resetsAt = Date.parse(limit.resetsAt);
  return Number.isFinite(resetsAt) ? resetsAt + USAGE_LIMIT_RESUME_DELAY_MS : null;
}
