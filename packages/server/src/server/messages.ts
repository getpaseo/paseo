import type { ManagedAgent } from "./agent/agent-manager.js";
import { toAgentPayload } from "./agent/agent-projections.js";
import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
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
  return event as AgentStreamEventPayload;
}
