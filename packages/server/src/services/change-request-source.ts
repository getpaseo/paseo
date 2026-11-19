import { z } from "zod";

const changeRequestCheckSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.url({ protocol: /^https?$/ }).optional(),
  state: z.enum(["pending", "failed", "passed", "neutral"]),
});
export const changeRequestStatusSchema = z.object({
  state: z.enum(["open", "closed", "merged"]),
  headSha: z.string(),
  checksState: z.enum(["pending", "failed", "passed", "neutral"]),
  checks: z.array(changeRequestCheckSchema),
  reviewDecision: z.string().nullable(),
});
const changeRequestSnapshotSchema = changeRequestStatusSchema.extend({
  activity: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["comment", "inline comment", "review"]),
      url: z.string(),
    }),
  ),
});

export type ChangeRequestSnapshot = z.infer<typeof changeRequestSnapshotSchema>;

export interface ChangeRequestSource {
  /** Resolve the URL to the forge's canonical change request address. */
  resolve(url: string): string;
  /** Human-readable identity for a canonical change request address. */
  describe(url: string): string;
  observe(
    url: string,
    callbacks: {
      snapshot(snapshot: ChangeRequestSnapshot): Promise<void>;
      error(error: unknown): void;
      /** Activity the daemon has committed to its baseline. */
      knownActivity?(): ReadonlySet<string>;
    },
  ): () => void;
}
