/**
 * The agent the user has focused: the one the Command Center hands to agent items. The Command
 * Center registration reads the router and the workspace layout, publishes the answer here, and
 * publishes `null` outside a workspace. A plugin's `{ focused: true }` composer reads it from here,
 * so both name the same agent and neither imports the navigation or layout stores.
 */
export interface FocusedAgent {
  serverId: string;
  agentId: string;
}

let current: FocusedAgent | null = null;
const listeners = new Set<() => void>();

export function publishFocusedAgent(next: FocusedAgent | null): void {
  if (current?.serverId === next?.serverId && current?.agentId === next?.agentId) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getFocusedAgent(): FocusedAgent | null {
  return current;
}

export function subscribeFocusedAgent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
