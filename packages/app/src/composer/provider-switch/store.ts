import { create } from "zustand";
import type { AgentProvider, ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { AgentConfigApply } from "@getpaseo/protocol/messages";

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
  applyAgentConfig?: (
    agentId: string,
    config: AgentConfigApply,
    options?: { expectedProvider?: AgentProvider },
  ) => Promise<unknown>;
  setAgentModel?: (
    agentId: string,
    modelId: string | null,
    options?: { expectedProvider?: AgentProvider },
  ) => Promise<unknown>;
  setAgentMode?: (
    agentId: string,
    modeId: string,
    options?: { expectedProvider?: AgentProvider },
  ) => Promise<unknown>;
  setAgentThinkingOption?: (
    agentId: string,
    thinkingOptionId: string,
    options?: { expectedProvider?: AgentProvider },
  ) => Promise<unknown>;
  setAgentOptions?: (
    agentId: string,
    options: ProviderOptions,
    mutationOptions?: { expectedProvider?: AgentProvider },
  ) => Promise<unknown>;
}

export interface FailedStartupSettings {
  provider: AgentProvider;
  bundle: AgentConfigApply;
  errorMessage: string;
}

export type SettleCommittedProviderSwitchResult =
  | { applied: true }
  | { applied: false; errorMessage: string };

interface StagedProviderSwitchState {
  stagedByKey: Map<string, StagedProviderSwitch>;
  inFlightByKey: Map<string, number>;
  failedStartupSettingsByKey: Map<string, FailedStartupSettings>;
  stage: (serverId: string, agentId: string, draft: StagedProviderSwitch) => void;
  patch: (
    serverId: string,
    agentId: string,
    updater: (current: StagedProviderSwitch) => StagedProviderSwitch,
  ) => void;
  beginSwitch: (serverId: string, agentId: string) => void;
  endSwitch: (serverId: string, agentId: string) => void;
  setFailedStartupSettings: (
    serverId: string,
    agentId: string,
    failed: FailedStartupSettings | null,
  ) => void;
  settle: (serverId: string, agentId: string, sentDraft: StagedProviderSwitch) => void;
  clear: (serverId: string, agentId: string) => void;
  clearForServer: (serverId: string) => void;
}

export const useStagedProviderSwitchStore = create<StagedProviderSwitchState>((set) => ({
  stagedByKey: new Map(),
  inFlightByKey: new Map(),
  failedStartupSettingsByKey: new Map(),

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

  setFailedStartupSettings: (serverId, agentId, failed) =>
    set((state) => {
      const key = stagedKey(serverId, agentId);
      const next = new Map(state.failedStartupSettingsByKey);
      if (failed === null) {
        if (!next.has(key)) return state;
        next.delete(key);
      } else {
        next.set(key, failed);
      }
      return { failedStartupSettingsByKey: next };
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
      const nextFailed = new Map(state.failedStartupSettingsByKey);
      for (const key of nextFailed.keys()) {
        if (key.startsWith(prefix)) {
          nextFailed.delete(key);
          changed = true;
        }
      }
      return changed
        ? {
            stagedByKey: next,
            inFlightByKey: nextInFlight,
            failedStartupSettingsByKey: nextFailed,
          }
        : state;
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

export function getFailedStartupSettings(
  serverId: string,
  agentId: string,
): FailedStartupSettings | null {
  return (
    useStagedProviderSwitchStore
      .getState()
      .failedStartupSettingsByKey.get(stagedKey(serverId, agentId)) ?? null
  );
}

export function useFailedStartupSettings(
  serverId: string,
  agentId: string,
): FailedStartupSettings | null {
  return useStagedProviderSwitchStore(
    (state) => state.failedStartupSettingsByKey.get(stagedKey(serverId, agentId)) ?? null,
  );
}

export function discardFailedStartupSettings(serverId: string, agentId: string): void {
  useStagedProviderSwitchStore.getState().setFailedStartupSettings(serverId, agentId, null);
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

function buildEditedSettingsBundle(
  sentDraft: StagedProviderSwitch,
  editedDraft: StagedProviderSwitch,
): AgentConfigApply | null {
  const config: AgentConfigApply = {};
  let hasChanges = false;
  if (editedDraft.model !== sentDraft.model) {
    config.modelId = editedDraft.model;
    hasChanges = true;
  }
  if (editedDraft.modeId !== sentDraft.modeId && editedDraft.modeId !== null) {
    config.modeId = editedDraft.modeId;
    hasChanges = true;
  }
  if (
    editedDraft.thinkingOptionId !== sentDraft.thinkingOptionId &&
    editedDraft.thinkingOptionId !== null
  ) {
    config.thinkingOptionId = editedDraft.thinkingOptionId;
    hasChanges = true;
  }
  const optionsPatch = diffProviderOptions(sentDraft.providerOptions, editedDraft.providerOptions);
  if (optionsPatch) {
    config.options = optionsPatch;
    hasChanges = true;
  }
  return hasChanges ? config : null;
}

async function applyEditedDraftSettingsToLiveAgent(
  agentId: string,
  bundle: AgentConfigApply,
  expectedProvider: AgentProvider,
  client: LiveAgentSettingsWriter,
): Promise<void> {
  const providerGuard = { expectedProvider };
  if (client.applyAgentConfig) {
    await client.applyAgentConfig(agentId, bundle, providerGuard);
    return;
  }
  if (bundle.modelId !== undefined && client.setAgentModel) {
    await client.setAgentModel(agentId, bundle.modelId, providerGuard);
  }
  if (bundle.modeId !== undefined && client.setAgentMode) {
    await client.setAgentMode(agentId, bundle.modeId, providerGuard);
  }
  if (
    bundle.thinkingOptionId !== undefined &&
    bundle.thinkingOptionId !== null &&
    client.setAgentThinkingOption
  ) {
    await client.setAgentThinkingOption(agentId, bundle.thinkingOptionId, providerGuard);
  }
  if (bundle.options && client.setAgentOptions) {
    await client.setAgentOptions(agentId, bundle.options, providerGuard);
  }
}

/**
 * Settles the staged draft captured by a committed switch and awaits any edited settings
 * for the provider that just became live before callers release queued follow-up prompts.
 * - Untouched draft: cleared.
 * - Newer draft targeting a different provider: preserved for the next switch.
 * - Newer draft editing settings of the provider that just became live: applied atomically
 *   (via `applyAgentConfig` when available, else sequential setters) before settling the draft.
 *   If the daemon rejects an edit, the draft is kept intact and `{ applied: false, errorMessage }`
 *   is returned so callers surface the error and hold any queued follow-up prompt.
 */
export async function settleCommittedProviderSwitch(input: {
  serverId: string;
  agentId: string;
  sentDraft: StagedProviderSwitch;
  committedProvider?: AgentProvider | null;
  client?: LiveAgentSettingsWriter | null;
}): Promise<SettleCommittedProviderSwitchResult> {
  const { serverId, agentId, sentDraft, committedProvider, client } = input;
  const store = useStagedProviderSwitchStore.getState();
  store.settle(serverId, agentId, sentDraft);
  const remaining = getStagedProviderSwitch(serverId, agentId);
  const liveProvider = committedProvider ?? sentDraft.provider;
  if (!remaining || remaining.provider !== liveProvider) {
    return { applied: true };
  }
  const bundle = buildEditedSettingsBundle(sentDraft, remaining);
  if (!bundle || !client) {
    store.settle(serverId, agentId, remaining);
    return { applied: true };
  }
  try {
    await applyEditedDraftSettingsToLiveAgent(agentId, bundle, liveProvider, client);
    store.settle(serverId, agentId, remaining);
    return { applied: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    store.settle(serverId, agentId, remaining);
    store.setFailedStartupSettings(serverId, agentId, {
      provider: liveProvider,
      bundle,
      errorMessage,
    });
    console.warn("[ProviderSwitch] failed to forward edited settings after switch", error);
    return { applied: false, errorMessage };
  }
}

/** Retries applying previously failed startup settings for a committed provider switch. */
export async function applyFailedStartupSettings(input: {
  serverId: string;
  agentId: string;
  client: LiveAgentSettingsWriter;
}): Promise<SettleCommittedProviderSwitchResult> {
  const { serverId, agentId, client } = input;
  const failed = getFailedStartupSettings(serverId, agentId);
  if (!failed) {
    return { applied: true };
  }
  const store = useStagedProviderSwitchStore.getState();
  try {
    await applyEditedDraftSettingsToLiveAgent(agentId, failed.bundle, failed.provider, client);
    store.setFailedStartupSettings(serverId, agentId, null);
    return { applied: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    store.setFailedStartupSettings(serverId, agentId, { ...failed, errorMessage });
    console.warn("[ProviderSwitch] failed to retry startup settings", error);
    return { applied: false, errorMessage };
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
