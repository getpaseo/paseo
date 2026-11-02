import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { FormPreferences } from "@/hooks/use-form-preferences";
import {
  INITIAL_AGENT_FORM_RESOLUTION,
  INITIAL_USER_MODIFIED,
  isUnlistedModel,
  resolveAgentForm,
  type AgentFormAction,
  type AgentFormReducerState,
} from "@/provider-selection/resolve-agent-form";

/** What the host offers right now. The store reads it when a command runs, never earlier. */
export interface AgentFormCatalog {
  /** The providers the host can run. */
  selectableProviders: ReadonlyMap<AgentProvider, AgentProviderDefinition>;
  /** Each provider's selectable models; empty when the host has listed none. */
  models: ReadonlyMap<string, AgentModelDefinition[]>;
  providerPreferences: (
    provider: AgentProvider,
  ) => NonNullable<FormPreferences["providerPreferences"]>[AgentProvider] | undefined;
}

/**
 * The draft form as a plain model: `resolveAgentForm` applied synchronously. A command reads
 * `getState()` and the catalog when it runs, so the one after `await setProvider(...)` sees the
 * new provider instead of the render that created it.
 */
export interface AgentFormStore {
  getState: () => AgentFormReducerState;
  dispatch: (action: AgentFormAction) => void;
  subscribe: (listener: () => void) => () => void;
  /** `false` when the provider is unknown or not ready; the form is left as it was. */
  setProviderAndModel: (provider: AgentProvider, modelId: string) => boolean;
  /**
   * `false` when the provider's catalog is loaded and does not list the model. A catalog that has
   * not arrived keeps the id as given.
   */
  setModel: (modelId: string) => boolean;
}

export function openAgentForm(catalog: () => AgentFormCatalog): AgentFormStore {
  let state: AgentFormReducerState = {
    form: { provider: null, modeId: "", model: "", thinkingOptionId: "" },
    userModified: INITIAL_USER_MODIFIED,
    resolution: INITIAL_AGENT_FORM_RESOLUTION,
  };
  const listeners = new Set<() => void>();
  function dispatch(action: AgentFormAction): void {
    const next = resolveAgentForm(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    dispatch,
    setProviderAndModel: (provider, modelId) => {
      const host = catalog();
      const providerDef = host.selectableProviders.get(provider);
      if (!providerDef) return false;
      dispatch({
        type: "SET_PROVIDER_AND_MODEL_FROM_USER",
        provider,
        modelId,
        providerDef,
        providerModels: host.models.get(provider) ?? null,
        providerPrefs: host.providerPreferences(provider),
      });
      return true;
    },
    setModel: (modelId) => {
      const { provider } = state.form;
      const host = catalog();
      const listed = provider ? host.models.get(provider) : undefined;
      const models = listed?.length ? listed : null;
      if (isUnlistedModel(models, modelId)) return false;
      dispatch({
        type: "SET_MODEL_FROM_USER",
        modelId,
        availableModels: models,
        providerPrefs: provider ? host.providerPreferences(provider) : undefined,
      });
      return true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
