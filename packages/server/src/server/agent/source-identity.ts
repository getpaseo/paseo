import { z } from "zod";

const SourceBaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageVersion: z.string().min(1),
    daemonVersion: z.string().min(1),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export type SourceBaseline = z.infer<typeof SourceBaselineSchema>;

export function verifyReviewedSourceIdentity(
  baseline: unknown,
  observed: {
    packageVersion: string | null;
    daemonVersion: string | null;
    sourceSha: string | null;
  },
): { allowed: true } | { allowed: false; reason: "source_identity_mismatch" } {
  const expected = SourceBaselineSchema.parse(baseline);
  if (
    observed.packageVersion !== expected.packageVersion ||
    observed.daemonVersion !== expected.daemonVersion ||
    observed.sourceSha !== expected.sourceSha
  ) {
    return { allowed: false, reason: "source_identity_mismatch" };
  }
  return { allowed: true };
}
