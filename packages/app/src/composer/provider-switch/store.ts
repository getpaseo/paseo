import { create } from "zustand";
import type { AgentProvider, ProviderOptions } from "@getpaseo/protocol/agent-types";

export interface StagedProviderSwitch {
  provider: AgentProvider;
  model: string | null;
  thinkingOptionId: string | null;
  modeId: string | null;
  providerOptions: ProviderOptions;
}

function stagedKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export interface LiveAgentSettingsWriter {
  setAgentModel?: (agentId: string, modelId: string | null) => Promise<unknown>;
  setAgentMode?: (agentId: string, modeId: string) => Promise<unknown>;
  setAgentThinkingOption?: (agentId: string, thinkingOptionId: string) => Promise<unknown>;
  setAgentOptions?: (agentId: string, options: ProviderOptions) => Promise<unknown>;
}

interface StagedProviderSwitchState {
  stagedByKey: Map<string, StagedProviderSwitch>;
  inFlightByKey: Map<string, number>;
  stage: (serverId: string, agentId: string, draft: StagedProviderSwitch) => void;
  patch: (
    serverId: string,
    agentId: string,
    updater: (current: StagedProviderSwitch) => StagedProviderSwitch,
  ) => void;
  beginSwitch: (serverId: string, agentId: string) => void;
  endSwitch: (serverId: string, agentId: string) => void;
  settle: (serverId: string, agentId: string, sentDraft: StagedProviderSwitch) => void;
  clear: (serverId: string, agentId: string) => void;
  clearForServer: (serverId: string) => void;
}

export const useStagedProviderSwitchStore = create<StagedProviderSwitchState>((set) => ({
  stagedByKey: new Map(),
  inFlightByKey: new Map(),

  stage: (serverId, agentId, draft) =>
    set((state) => {
      const next = new Map(state.stagedByKey);
      next.set(stagedKey(serverId, agentId), draft);
      return { stagedByKey: next };
    }),

  patch: (serverId, agentId, updater) =>
    set((state) => {
      const key = stagedKey(serverId, agentId);
      const current = state.stagedByKey.get(key);
      if (!current) return state;
      const updated = updater(current);
      if (updated === current) return state;
      const next = new Map(state.stagedByKey);
      next.set(key, updated);
      return { stagedByKey: next };
    }),

  beginSwitch: (serverId, agentId) =>
    set((state) => {
      const key = stagedKey(serverId, agentId);
      const next = new Map(state.inFlightByKey);
      next.set(key, (next.get(key) ?? 0) + 1);
      return { inFlightByKey: next };
    }),

  endSwitch: (serverId, agentId) =>
    set((state) => {
      const key = stagedKey(serverId, agentId);
      const count = state.inFlightByKey.get(key) ?? 0;
      if (count <= 0) return state;
      const next = new Map(state.inFlightByKey);
      if (count === 1) {
        next.delete(key);
      } else {
        next.set(key, count - 1);
      }
      return { inFlightByKey: next };
    }),

  settle: (serverId, agentId, sentDraft) =>
    set((state) => {
      const key = stagedKey(serverId, agentId);
      const current = state.stagedByKey.get(key);
      if (!current || current !== sentDraft) return state;
      const next = new Map(state.stagedByKey);
      next.delete(key);
      return { stagedByKey: next };
    }),

  clear: (serverId, agentId) =>
    set((state) => {
      const key = stagedKey(serverId, agentId);
      if (!state.stagedByKey.has(key)) return state;
      const next = new Map(state.stagedByKey);
      next.delete(key);
      return { stagedByKey: next };
    }),

  clearForServer: (serverId) =>
    set((state) => {
      const prefix = `${serverId}:`;
      let changed = false;
      const next = new Map(state.stagedByKey);
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key);
          changed = true;
        }
      }
      const nextInFlight = new Map(state.inFlightByKey);
      for (const key of nextInFlight.keys()) {
        if (key.startsWith(prefix)) {
          nextInFlight.delete(key);
          changed = true;
        }
      }
      return changed ? { stagedByKey: next, inFlightByKey: nextInFlight } : state;
    }),
}));

export function getStagedProviderSwitch(
  serverId: string,
  agentId: string,
): StagedProviderSwitch | null {
  return (
    useStagedProviderSwitchStore.getState().stagedByKey.get(stagedKey(serverId, agentId)) ?? null
  );
}

export function beginStagedProviderSwitch(serverId: string, agentId: string): void {
  useStagedProviderSwitchStore.getState().beginSwitch(serverId, agentId);
}

export function endStagedProviderSwitch(serverId: string, agentId: string): void {
  useStagedProviderSwitchStore.getState().endSwitch(serverId, agentId);
}

export function isStagedProviderSwitchInFlight(serverId: string, agentId: string): boolean {
  return (
    (useStagedProviderSwitchStore.getState().inFlightByKey.get(stagedKey(serverId, agentId)) ?? 0) >
    0
  );
}

export function settleStagedProviderSwitch(
  serverId: string,
  agentId: string,
  sentDraft: StagedProviderSwitch,
): void {
  useStagedProviderSwitchStore.getState().settle(serverId, agentId, sentDraft);
}

function diffProviderOptions(
  sent: ProviderOptions,
  edited: ProviderOptions,
): ProviderOptions | null {
  const patch: ProviderOptions = {};
  let hasDiff = false;
  for (const [key, value] of Object.entries(edited)) {
    if (sent[key] !== value) {
      patch[key] = value;
      hasDiff = true;
    }
  }
  return hasDiff ? patch : null;
}

async function applyEditedDraftSettingsToLiveAgent(
  agentId: string,
  sentDraft: StagedProviderSwitch,
  editedDraft: StagedProviderSwitch,
  client: LiveAgentSettingsWriter,
): Promise<void> {
  if (editedDraft.model !== sentDraft.model && client.setAgentModel) {
    await client.setAgentModel(agentId, editedDraft.model).catch((error) => {
      console.warn("[ProviderSwitch] failed to forward edited model after switch", error);
    });
  }
  if (
    editedDraft.modeId !== sentDraft.modeId &&
    editedDraft.modeId !== null &&
    client.setAgentMode
  ) {
    await client.setAgentMode(agentId, editedDraft.modeId).catch((error) => {
      console.warn("[ProviderSwitch] failed to forward edited mode after switch", error);
    });
  }
  if (
    editedDraft.thinkingOptionId !== sentDraft.thinkingOptionId &&
    editedDraft.thinkingOptionId !== null &&
    client.setAgentThinkingOption
  ) {
    await client.setAgentThinkingOption(agentId, editedDraft.thinkingOptionId).catch((error) => {
      console.warn("[ProviderSwitch] failed to forward edited thinking option after switch", error);
    });
  }
  const optionsPatch = diffProviderOptions(sentDraft.providerOptions, editedDraft.providerOptions);
  if (optionsPatch && client.setAgentOptions) {
    await client.setAgentOptions(agentId, optionsPatch).catch((error) => {
      console.warn(
        "[ProviderSwitch] failed to forward edited provider options after switch",
        error,
      );
    });
  }
}

/**
 * Settles the staged draft captured by a committed switch.
 * - Untouched draft: cleared.
 * - Newer draft targeting a different provider: preserved for the next switch.
 * - Newer draft editing settings of the provider that just became live: settled and forwarded
 *   to the live agent so the next prompt uses the edited settings.
 */
export function settleCommittedProviderSwitch(input: {
  serverId: string;
  agentId: string;
  sentDraft: StagedProviderSwitch;
  committedProvider?: AgentProvider | null;
  client?: LiveAgentSettingsWriter | null;
}): void {
  const { serverId, agentId, sentDraft, committedProvider, client } = input;
  const store = useStagedProviderSwitchStore.getState();
  store.settle(serverId, agentId, sentDraft);
  const remaining = getStagedProviderSwitch(serverId, agentId);
  const liveProvider = committedProvider ?? sentDraft.provider;
  if (!remaining || remaining.provider !== liveProvider) {
    return;
  }
  store.settle(serverId, agentId, remaining);
  if (client) {
    void applyEditedDraftSettingsToLiveAgent(agentId, sentDraft, remaining, client);
  }
}

export function clearStagedProviderSwitch(serverId: string, agentId: string): void {
  useStagedProviderSwitchStore.getState().clear(serverId, agentId);
}

export function useStagedProviderSwitch(
  serverId: string,
  agentId: string,
): StagedProviderSwitch | null {
  return useStagedProviderSwitchStore(
    (state) => state.stagedByKey.get(stagedKey(serverId, agentId)) ?? null,
  );
}
