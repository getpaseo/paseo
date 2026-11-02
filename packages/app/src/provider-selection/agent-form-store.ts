import {
  INITIAL_AGENT_FORM_RESOLUTION,
  INITIAL_USER_MODIFIED,
  resolveAgentForm,
  type AgentFormAction,
  type AgentFormReducerState,
} from "@/provider-selection/resolve-agent-form";

/**
 * The draft form as a plain model: `resolveAgentForm` applied synchronously. A command reads
 * `getState()` when it runs, so the one after `await setProvider(...)` sees the new provider
 * instead of the render that created it.
 */
export interface AgentFormStore {
  getState: () => AgentFormReducerState;
  dispatch: (action: AgentFormAction) => void;
  subscribe: (listener: () => void) => () => void;
}

export function openAgentForm(): AgentFormStore {
  let state: AgentFormReducerState = {
    form: { provider: null, modeId: "", model: "", thinkingOptionId: "" },
    userModified: INITIAL_USER_MODIFIED,
    resolution: INITIAL_AGENT_FORM_RESOLUTION,
  };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = resolveAgentForm(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
