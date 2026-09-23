import { z } from "zod";

const common = {
  id: z.string(),
  timestamp: z.string(),
  text: z.string(),
  truncated: z.boolean(),
};

export const CompanionEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("question"),
    status: z.enum(["open", "reviewed", "done", "reply_sent"]),
  }),
  z.object({
    ...common,
    kind: z.literal("feature_request"),
    status: z.enum(["open", "reviewed", "done"]),
  }),
  z.object({
    ...common,
    kind: z.literal("permission"),
    requestId: z.string(),
    requestKind: z.enum(["tool", "plan", "question", "mode", "other"]),
    status: z.enum(["pending", "allowed", "denied", "expired"]),
  }),
  z.object({
    ...common,
    kind: z.literal("outcome"),
    status: z.enum(["completed", "failed", "canceled"]),
  }),
  z.object({
    ...common,
    kind: z.literal("pin"),
    sourceId: z.string().optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("q_and_a"),
    answer: z.string().optional(),
    questionMessageId: z.string().optional(),
    answerMessageId: z.string().optional(),
  }),
]);

export type CompanionEntry = z.infer<typeof CompanionEntrySchema>;

export function isCompanionEntryPending(entry: CompanionEntry): boolean {
  return (
    (entry.kind === "question" && entry.status === "open") ||
    (entry.kind === "feature_request" && entry.status === "open") ||
    (entry.kind === "permission" && entry.status === "pending")
  );
}
