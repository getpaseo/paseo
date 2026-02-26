import type { AgentTimelineItem, DaemonClient } from '@junction/server'

type FetchProjectedTimelineItemsInput = {
  client: DaemonClient
  agentId: string
}

export async function fetchProjectedTimelineItems(
  input: FetchProjectedTimelineItemsInput
): Promise<AgentTimelineItem[]> {
  const timeline = await input.client.fetchAgentTimeline(input.agentId, {
    direction: 'tail',
    limit: 0,
    projection: 'projected',
  })
  return timeline.entries.map((entry) => entry.item)
}
