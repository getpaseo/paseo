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
    status: z.enum(["open", "reply_sent"]),
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
]);

export type CompanionEntry = z.infer<typeof CompanionEntrySchema>;

export function isCompanionEntryPending(entry: CompanionEntry): boolean {
  return (
    (entry.kind === "question" && entry.status === "open") ||
    (entry.kind === "permission" && entry.status === "pending")
  );
}
