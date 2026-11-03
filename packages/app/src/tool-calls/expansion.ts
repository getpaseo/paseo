type Listener = () => void;

/** Which tool call groups are open. A new value is published only when a group is toggled. */
export interface ExpandedToolCallGroups {
  has(groupId: string): boolean;
}

/**
 * Open state of one agent's tool calls and tool call groups.
 *
 * A group takes its first call's id. Opening a lone call (`standalone`) also opens the group it
 * will host once a second call arrives, without publishing a group change: the timeline renders
 * that row again when the group forms and reads the open state then. A call toggle notifies only
 * that call's subscribers.
 */
export function createToolCallExpansion() {
  const calls = new Map<string, boolean>();
  const callListeners = new Map<string, Set<Listener>>();
  const groups = new Set<string>();
  const groupListeners = new Set<Listener>();
  let expandedGroups = createExpandedGroups();

  function createExpandedGroups(): ExpandedToolCallGroups {
    return { has: (groupId) => groups.has(groupId) };
  }

  function writeGroup(groupId: string, expanded: boolean) {
    if (expanded) groups.add(groupId);
    else groups.delete(groupId);
  }

  return {
    isCallExpanded: (callId: string, defaultExpanded: boolean) =>
      calls.get(callId) ?? defaultExpanded,
    subscribeCall(callId: string, listener: Listener) {
      let listeners = callListeners.get(callId);
      if (!listeners) {
        listeners = new Set();
        callListeners.set(callId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) callListeners.delete(callId);
      };
    },
    setCallExpanded(input: { callId: string; expanded: boolean; standalone: boolean }) {
      calls.set(input.callId, input.expanded);
      if (input.standalone) writeGroup(input.callId, input.expanded);
      for (const listener of callListeners.get(input.callId) ?? []) listener();
    },
    getExpandedGroups: () => expandedGroups,
    subscribeGroups(listener: Listener) {
      groupListeners.add(listener);
      return () => {
        groupListeners.delete(listener);
      };
    },
    setGroupExpanded(groupId: string, expanded: boolean) {
      writeGroup(groupId, expanded);
      expandedGroups = createExpandedGroups();
      for (const listener of groupListeners) listener();
    },
  };
}

export type ToolCallExpansion = ReturnType<typeof createToolCallExpansion>;
