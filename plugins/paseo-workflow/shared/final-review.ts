import { z } from "zod";

export const classification = z.enum(["SIMPLE", "STRUCTURAL", "SENSITIVE"]);
export type Classification = z.infer<typeof classification>;
export const finding = z.object({
  summary: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  certain: z.boolean(),
  local: z.boolean(),
  verifiable: z.boolean(),
  externalEffects: z.boolean(),
});
export const auditDecision = z.object({ findings: z.array(finding) });
export type AuditDecision = z.infer<typeof auditDecision>;
export const correctionDecision = z.object({
  correct: z.boolean(),
  validationCommands: z.array(z.string().min(1)),
});

export function auditorsFor(level: Classification) {
  if (level === "SIMPLE") return ["audit-economic"] as const;
  if (level === "STRUCTURAL") return ["audit-deep"] as const;
  return ["audit-deep", "audit-security"] as const;
}

export interface FinalReview {
  phase:
    | "classifying"
    | "auditing"
    | "deciding"
    | "correcting"
    | "delta"
    | "committing"
    | "complete"
    | "verification_required";
  managerId: string;
  head: string;
  diff: string;
  dirtyFiles: string[];
  classification?: Classification;
  audits: Record<string, { agentId: string; result?: AuditDecision }>;
  validationCommands?: string[];
  correctionDiff?: string;
  deltaId?: string;
  reason?: string;
}
