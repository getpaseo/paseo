import { z } from "zod";

export const TERMINAL_ACTIVITY_STATES = ["idle", "working", "attention"] as const;

export type TerminalActivityState = (typeof TERMINAL_ACTIVITY_STATES)[number];

export const TerminalActivitySchema = z.object({
  // Forward-compat: a newer daemon may send a state this client doesn't know.
  // Degrade unknown states to "idle" (no indicator, no notification) so the
  // message still parses, instead of a strict enum rejecting the whole payload.
  state: z.enum(TERMINAL_ACTIVITY_STATES).catch("idle"),
  changedAt: z.number(),
});

export type TerminalActivity = z.infer<typeof TerminalActivitySchema>;
