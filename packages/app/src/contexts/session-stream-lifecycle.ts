import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";
import type { AgentStreamEventPayload } from "@server/shared/messages";

export function deriveOptimisticLifecycleStatus(
  currentStatus: AgentLifecycleStatus,
  event: AgentStreamEventPayload
): AgentLifecycleStatus | null {
  if (currentStatus !== "running") {
    return null;
  }
  switch (event.type) {
    case "turn_completed":
    case "turn_canceled":
      return "idle";
    case "turn_failed":
      return "error";
    default:
      return null;
  }
}
