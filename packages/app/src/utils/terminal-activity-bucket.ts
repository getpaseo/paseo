import type { TerminalActivityState } from "@getpaseo/protocol/terminal-activity";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export function terminalActivityToStatusBucket(
  state: TerminalActivityState | null | undefined,
): SidebarStateBucket | null {
  if (state === "working") return "running";
  if (state === "attention") return "needs_input";
  return null;
}
