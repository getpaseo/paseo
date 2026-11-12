export type PluginTimelineTarget = "last-user-message";

type TimelineNavigator = (target: PluginTimelineTarget) => void;

const navigators = new Map<string, TimelineNavigator>();

function key(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function registerAgentTimelineNavigator(
  serverId: string,
  agentId: string,
  navigate: TimelineNavigator,
): () => void {
  const id = key(serverId, agentId);
  navigators.set(id, navigate);
  return () => {
    if (navigators.get(id) === navigate) navigators.delete(id);
  };
}

/** No-ops while the agent transcript is not mounted. */
export function scrollAgentTimeline(
  serverId: string,
  agentId: string,
  target: PluginTimelineTarget,
): void {
  navigators.get(key(serverId, agentId))?.(target);
}
