import type { ManagedAgent } from "./agent/agent-manager.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import { stripLeadingPaseoInstructionTag } from "./agent/paseo-instructions-tag.js";
import type {
  AgentSnapshotPayload,
  AgentStreamEventPayload,
} from "../shared/messages.js";

export * from "../shared/messages.js";

export function serializeAgentSnapshot(
  agent: ManagedAgent,
  options?: { title?: string | null }
): AgentSnapshotPayload {
  return toAgentPayload(agent, options);
}

export function serializeAgentStreamEvent(
  event: AgentStreamEvent
): AgentStreamEventPayload {
  if (event.type === "attention_required") {
    // Providers may emit attention_required without per-client notification context.
    // The websocket bridge also emits attention_required with shouldNotify computed per client.
    // Normalize provider events so they satisfy the shared schema.
    return {
      ...(event as Omit<AgentStreamEventPayload, "shouldNotify">),
      shouldNotify: false,
    } as AgentStreamEventPayload;
  }
  if (event.type !== "timeline") {
    return event as AgentStreamEventPayload;
  }
  if (event.item.type !== "user_message") {
    return event as AgentStreamEventPayload;
  }
  const stripped = stripLeadingPaseoInstructionTag(event.item.text);
  if (stripped === event.item.text) {
    return event as AgentStreamEventPayload;
  }
  return {
    ...event,
    item: {
      ...event.item,
      text: stripped,
    },
  } as AgentStreamEventPayload;
}
