import type { AgentTimelineItem } from "../../../agent-sdk-types.js";
import type {
  ProviderSubagentInputEvent,
  ProviderSubagentStatus,
} from "../../../provider-subagents/store.js";

/**
 * A single fact a provider observed about one subagent.
 *
 * Sources translate their wire format into observations and do nothing else: no state machine,
 * no accumulation, no dedupe. That keeps the live stream and the on-disk replay speaking one
 * vocabulary, so a fact is derived once instead of once per path.
 *
 * The union is deliberately small. Model, effort, and usage need descriptor fields that do not
 * exist yet; they arrive as new variants when those land.
 */
export type SubagentObservation =
  | {
      /** The subagent exists, and here is what it was asked to do. */
      kind: "declared";
      id: string;
      /** Subagent type, e.g. "Explore". Identical across a fan-out — not the task. */
      title?: string;
      /** The task this child was given. What actually distinguishes it from its siblings. */
      description?: string;
      toolCallId?: string;
      timestamp?: string;
    }
  | { kind: "status"; id: string; status: ProviderSubagentStatus; timestamp?: string }
  | { kind: "timeline"; id: string; item: AgentTimelineItem; timestamp?: string };

/**
 * Turn observations into store events.
 *
 * Pure and stateless by construction. Both the task protocol and a persisted transcript are
 * edge-triggered — a subagent is declared once and its status changes only when it changes — so
 * there is nothing to debounce here. Accumulation across partial upserts is the store's sticky
 * merge (omitted field preserves, explicit null clears), which is why a `status` observation can
 * carry status alone without blanking the title.
 */
export function foldSubagentObservations(
  observations: readonly SubagentObservation[],
): ProviderSubagentInputEvent[] {
  const events: ProviderSubagentInputEvent[] = [];
  for (const observation of observations) {
    if (observation.kind === "timeline") {
      events.push({
        type: "timeline",
        id: observation.id,
        item: observation.item,
        ...(observation.timestamp ? { timestamp: observation.timestamp } : {}),
      });
      continue;
    }

    if (observation.kind === "status") {
      events.push({
        type: "upsert",
        id: observation.id,
        status: observation.status,
        ...(observation.timestamp ? { timestamp: observation.timestamp } : {}),
      });
      continue;
    }

    // A declared subagent is running until something says otherwise. Its terminal status
    // arrives as its own observation, so this never has to guess at completion.
    events.push({
      type: "upsert",
      id: observation.id,
      status: "running",
      ...(observation.title === undefined ? {} : { title: observation.title }),
      ...(observation.description === undefined ? {} : { description: observation.description }),
      ...(observation.toolCallId === undefined ? {} : { toolCallId: observation.toolCallId }),
      ...(observation.timestamp ? { timestamp: observation.timestamp } : {}),
    });
  }
  return events;
}
