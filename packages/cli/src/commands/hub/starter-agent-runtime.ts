import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface HubStarterAgentRuntime {
  provider: string;
  model: string;
  mode?: string;
}

export interface HubStarterAgentProvider {
  id: string;
  label: string;
  models: readonly HubStarterAgentModel[];
  modes: readonly HubStarterAgentMode[];
}

export interface HubStarterAgentModel {
  id: string;
  label: string;
  suggested: boolean;
}

export interface HubStarterAgentMode {
  id: string;
  label: string;
  suggested: boolean;
}

export type HubStarterAgentProviderSnapshotState =
  | { kind: "ready"; providers: readonly HubStarterAgentProvider[] }
  | { kind: "loading" }
  | { kind: "unavailable" };

export function availableStarterAgentProviders(
  entries: readonly ProviderSnapshotEntry[],
): HubStarterAgentProvider[] {
  return entries.flatMap((entry) => {
    if (entry.status !== "ready" || !entry.enabled) return [];
    const models = (entry.models ?? [])
      .filter((model) => model.isSelectable !== false)
      .map((model) => ({ id: model.id, label: model.label, suggested: model.isDefault === true }));
    if (models.length === 0) return [];

    const modes = (entry.modes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.label,
      suggested: mode.id === entry.defaultModeId,
    }));
    return [
      {
        id: entry.provider,
        label: entry.label ?? entry.provider,
        models,
        modes,
      },
    ];
  });
}

export function starterAgentProviderSnapshotState(
  entries: readonly ProviderSnapshotEntry[],
): HubStarterAgentProviderSnapshotState {
  const providers = availableStarterAgentProviders(entries);
  if (providers.length > 0) return { kind: "ready", providers };
  if (entries.length === 0) return { kind: "loading" };
  if (entries.some((entry) => entry.enabled && entry.status === "loading")) {
    return { kind: "loading" };
  }
  return { kind: "unavailable" };
}

export function suggestedStarterAgentChoice<T extends { suggested: boolean }>(
  choices: readonly T[],
): T | undefined {
  return choices.find((choice) => choice.suggested);
}

export function selectedStarterAgentRuntime(
  provider: HubStarterAgentProvider,
  modelId: string,
  modeId?: string,
): HubStarterAgentRuntime | undefined {
  if (!provider.models.some((model) => model.id === modelId)) return undefined;
  if (provider.modes.length === 0) {
    return modeId === undefined ? { provider: provider.id, model: modelId } : undefined;
  }
  if (modeId === undefined || !provider.modes.some((mode) => mode.id === modeId)) return undefined;
  return { provider: provider.id, model: modelId, mode: modeId };
}
