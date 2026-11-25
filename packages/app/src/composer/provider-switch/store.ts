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

interface StagedProviderSwitchState {
  stagedByKey: Map<string, StagedProviderSwitch>;
  stage: (serverId: string, agentId: string, draft: StagedProviderSwitch) => void;
  patch: (
    serverId: string,
    agentId: string,
    updater: (current: StagedProviderSwitch) => StagedProviderSwitch,
  ) => void;
  clear: (serverId: string, agentId: string) => void;
  clearForServer: (serverId: string) => void;
}

export const useStagedProviderSwitchStore = create<StagedProviderSwitchState>((set) => ({
  stagedByKey: new Map(),

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
      return changed ? { stagedByKey: next } : state;
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
