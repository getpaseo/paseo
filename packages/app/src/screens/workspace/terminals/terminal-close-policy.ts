import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";

export function shouldConfirmTerminalClose(activity: TerminalActivity | null | undefined): boolean {
  return activity?.state === "working" || activity?.attentionReason === "needs_input";
}
