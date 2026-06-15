import { z } from "zod";

export const TERMINAL_ACTIVITY_STATES = ["idle", "working", "attention"] as const;
export const TERMINAL_ACTIVITY_ATTENTION_REASONS = ["finished", "needs_input"] as const;

export type TerminalActivityState = (typeof TERMINAL_ACTIVITY_STATES)[number];
export type TerminalActivityAttentionReason = (typeof TERMINAL_ACTIVITY_ATTENTION_REASONS)[number];

export const TerminalActivitySchema = z.object({
  // Forward-compat: a newer daemon may send a state this client doesn't know.
  // Degrade unknown states to "idle" (no indicator, no notification) so the
  // message still parses, instead of a strict enum rejecting the whole payload.
  state: z.enum(TERMINAL_ACTIVITY_STATES).catch("idle"),
  attentionReason: z.enum(TERMINAL_ACTIVITY_ATTENTION_REASONS).nullable().optional().catch(null),
  changedAt: z.number(),
});

export type TerminalActivity = z.infer<typeof TerminalActivitySchema>;

export type TerminalActivityStatusBucket = "running" | "needs_input" | "attention";

export function deriveTerminalActivityStatusBucket(
  activity: TerminalActivity | null | undefined,
): TerminalActivityStatusBucket | null {
  if (!activity) return null;
  if (activity.attentionReason === "needs_input") return "needs_input";
  if (activity.attentionReason === "finished") return "attention";
  if (activity.state === "working") return "running";
  if (activity.state === "attention") return "needs_input";
  return null;
}
