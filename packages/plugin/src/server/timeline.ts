import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";

type TimelineSource = Pick<PaseoAgentTimelineHandle, "refetch">;

const PAGE_SIZE = 50;

/**
 * The latest turn of an agent: its last user message and everything after it, oldest first.
 * Turn hooks carry no history, so call this from `agent.turn.after` to read what the agent replied.
 * Returns the whole history when no user message exists yet.
 */
export async function latestTurn(timeline: TimelineSource): Promise<AgentTimelineItem[]> {
  const items: AgentTimelineItem[] = [];
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE });
  for (;;) {
    items.unshift(...page.entries.map((entry) => entry.item));
    const boundary = items.findLastIndex((item) => item.type === "user_message");
    if (boundary >= 0) return items.slice(boundary);
    if (!page.hasOlder || !page.startCursor) return items;
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: PAGE_SIZE,
    });
  }
}
