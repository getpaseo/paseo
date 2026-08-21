import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface HubStarterAgentRuntime {
  provider: string;
  model: string;
  mode?: string;
  label: string;
  suggested: boolean;
  key: string;
}

export function availableStarterAgentRuntimes(
  entries: readonly ProviderSnapshotEntry[],
): HubStarterAgentRuntime[] {
  return entries.flatMap((entry) => {
    if (entry.status !== "ready" || !entry.enabled) return [];
    const models = entry.models?.filter((model) => model.isSelectable !== false) ?? [];
    const modes = entry.modes ?? [];
    if (models.length === 0 || (modes.length > 0 && !hasDefaultMode(entry))) return [];

    return models.flatMap((model) =>
      (modes.length === 0 ? [undefined] : modes).map((mode) => createRuntime(entry, model, mode)),
    );
  });
}

export function suggestedStarterAgentRuntime(
  runtimes: readonly HubStarterAgentRuntime[],
): HubStarterAgentRuntime | undefined {
  return runtimes.find((runtime) => runtime.suggested);
}

function createRuntime(
  entry: ProviderSnapshotEntry,
  model: NonNullable<ProviderSnapshotEntry["models"]>[number],
  mode: NonNullable<ProviderSnapshotEntry["modes"]>[number] | undefined,
): HubStarterAgentRuntime {
  const runtime: HubStarterAgentRuntime = {
    provider: entry.provider,
    model: model.id,
    key: [entry.provider, model.id, mode?.id ?? ""].join("\u0000"),
    label: [entry.label ?? entry.provider, model.label, mode?.label].filter(Boolean).join(" · "),
    suggested: model.isDefault === true && (mode === undefined || mode.id === entry.defaultModeId),
  };
  if (mode !== undefined) runtime.mode = mode.id;
  return runtime;
}

function hasDefaultMode(entry: ProviderSnapshotEntry): boolean {
  return entry.modes?.some((mode) => mode.id === entry.defaultModeId) ?? false;
}
