import { z } from "zod";
import type { ForgeSpecificStatusFacts } from "@getpaseo/plugin/server";

// This schema is safe to import from both plugin runtimes.
export const CodeupRequirementChecksSchema = z
  .object({
    mergeConflict: z.boolean().nullable().optional().default(null),
    comments: z.boolean().nullable().optional().default(null),
    ci: z.boolean().nullable().optional().default(null),
    reviewerApproved: z.boolean().nullable().optional().default(null),
  })
  .passthrough();

export type CodeupRequirementChecks = z.infer<typeof CodeupRequirementChecksSchema>;

export const CodeupMergeFactsSchema = z
  .object({
    forge: z.literal("codeup"),
    status: z.string().optional().default(""),
    allRequirementsPass: z.boolean().optional().default(false),
    requirementChecks: CodeupRequirementChecksSchema.optional().default({
      mergeConflict: null,
      comments: null,
      ci: null,
      reviewerApproved: null,
    }),
  })
  .passthrough();

export type CodeupMergeFacts = z.infer<typeof CodeupMergeFactsSchema>;
export type CodeupStatusFacts = Pick<
  CodeupMergeFacts,
  "status" | "allRequirementsPass" | "requirementChecks"
>;
export type CodeupForgeSpecificStatusFacts = CodeupMergeFacts;

export function parseCodeupStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): CodeupForgeSpecificStatusFacts | null {
  const parsed = CodeupMergeFactsSchema.safeParse(facts);
  return parsed.success ? parsed.data : null;
}

export function isCodeupDirectMergeReady(facts: CodeupStatusFacts): boolean {
  return (
    facts.status === "TO_BE_MERGED" &&
    facts.allRequirementsPass &&
    Object.values(facts.requirementChecks).every((check) => check !== false)
  );
}
