import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type { AgentStreamEventPayload } from "@server/shared/messages";

export function deriveOptimisticLifecycleStatus(
  currentStatus: AgentLifecycleStatus,
  event: AgentStreamEventPayload,
): AgentLifecycleStatus | null {
  if (currentStatus !== "running") {
    return null;
  }
  switch (event.type) {
    case "turn_completed":
      return "idle";
    case "turn_failed":
      return "error";
    case "turn_canceled":
      // A canceled turn can be either a final user cancel or an interrupt
      // before a replacement turn starts. Returning "idle" here makes the
      // agent flash idle between turns during Codex replacement — defer to
      // the authoritative daemon snapshot instead. (Paseo commit 89efb00.)
      return null;
    default:
      return null;
  }
}
