export type PluginTimelineTarget = "last-user-message";

type TimelineNavigator = (target: PluginTimelineTarget) => void;

const navigators = new Map<string, TimelineNavigator>();

/** Returns the next user-message target, or keeps the existing target at the beginning. */
export function previousUserMessageId(
  userMessageIds: readonly string[],
  currentMessageId: string | null,
): string | null {
  if (userMessageIds.length === 0) return null;

  const currentIndex =
    currentMessageId === null ? userMessageIds.length : userMessageIds.indexOf(currentMessageId);
  if (currentIndex < 0) return userMessageIds.at(-1) ?? null;
  return userMessageIds[Math.max(0, currentIndex - 1)] ?? null;
}

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
