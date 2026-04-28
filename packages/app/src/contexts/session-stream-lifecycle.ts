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
      // A canceled turn can be either a final user cancel or an interrupt before
      // a replacement turn starts. The daemon snapshot is authoritative here.
      return null;
    default:
      return null;
  }
}
