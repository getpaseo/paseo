import type { SessionMessageInfo } from "@opencode/client";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import type { V2Timeline } from "../v2/timeline.js";

// Snapshot assertions without a live stream can collect the publisher's events.
export async function collectTimelineSnapshot(
  timeline: V2Timeline,
  messages: SessionMessageInfo[],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  await timeline.messages(messages, (event) => {
    events.push(event);
  });
  return events;
}
