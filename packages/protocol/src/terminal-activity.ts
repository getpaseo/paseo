import { z } from "zod";

export const TERMINAL_ACTIVITY_STATES = ["idle", "working", "attention"] as const;

export type TerminalActivityState = (typeof TERMINAL_ACTIVITY_STATES)[number];

export const TerminalActivitySchema = z.object({
  state: z.enum(TERMINAL_ACTIVITY_STATES),
  changedAt: z.number(),
});

export type TerminalActivity = z.infer<typeof TerminalActivitySchema>;
