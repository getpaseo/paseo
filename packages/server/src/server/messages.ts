import type { ManagedAgent } from "./agent/agent-manager.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
} from "../shared/messages.js";
import { AgentStreamEventPayloadSchema as AgentStreamEventPayloadRuntimeSchema } from "../shared/messages.js";

export * from "../shared/messages.js";

function validateStreamEventPayload(
  payload: unknown
): AgentStreamEventPayload | null {
  const parsed = AgentStreamEventPayloadRuntimeSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function serializeAgentSnapshot(
  agent: ManagedAgent,
  options?: { title?: string | null }
): AgentSnapshotPayload {
  return toAgentPayload(agent, options);
}

export function serializeAgentStreamEvent(
  event: AgentStreamEvent
): AgentStreamEventPayload | null {
  if (event.type === "attention_required") {
    // Providers may emit attention_required without per-client notification context.
    // The websocket server emits attention_required with shouldNotify computed per client.
    // Normalize provider events so they satisfy the shared schema.
    return validateStreamEventPayload({
      type: "attention_required",
      provider: event.provider,
      reason: event.reason,
      timestamp: event.timestamp,
      shouldNotify: false,
    });
  }

  return validateStreamEventPayload(event);
}
