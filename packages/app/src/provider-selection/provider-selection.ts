import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import { buildFavoriteModelKey, type FavoriteModelRow } from "@/hooks/use-form-preferences";
import { compareMatchScores, scoreTextFields } from "@/utils/score-match";

export type ProviderSelectionModelRow = FavoriteModelRow & { isDefault?: boolean };

export type ProviderModelSelection =
  | { kind: "models"; rows: ProviderSelectionModelRow[] }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export interface ProviderSelectorProvider {
  id: string;
  label: string;
  modelSelection: ProviderModelSelection;
}

export interface ProviderSelectionState {
  provider: AgentProvider | null;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  availableModels: AgentModelDefinition[];
  modeOptions: AgentMode[];
}

export interface ProviderSelectionReadiness {
  ok: boolean;
  reason?: string;
}

function buildModelRows(
  provider: string,
  providerLabel: string,
  models: AgentModelDefinition[],
): ProviderSelectionModelRow[] {
  return models.map((model) => ({
    favoriteKey: buildFavoriteModelKey({ provider, modelId: model.id }),
    provider,
    providerLabel,
    modelId: model.id,
    modelLabel: model.label,
    description: model.description,
    isDefault: model.isDefault,
  }));
}

function buildSyntheticDefaultRow(
  provider: string,
  providerLabel: string,
): ProviderSelectionModelRow {
  return {
    favoriteKey: buildFavoriteModelKey({ provider, modelId: "" }),
    provider,
    providerLabel,
    modelId: "",
    modelLabel: "Default",
    description: undefined,
    isDefault: true,
  };
}

function buildModelSelection(
  provider: string,
  providerLabel: string,
  models: AgentModelDefinition[] | null,
): ProviderModelSelection {
  if (models === null) {
    return { kind: "loading" };
  }
  if (models.length === 0) {
    return { kind: "models", rows: [buildSyntheticDefaultRow(provider, providerLabel)] };
  }
  return { kind: "models", rows: buildModelRows(provider, providerLabel, models) };
}

function buildEntryModelSelection(
  entry: ProviderSnapshotEntry,
  label: string,
): ProviderModelSelection {
  if ((entry.models?.length ?? 0) > 0) {
    return buildModelSelection(entry.provider, label, entry.models ?? null);
  }
  if (entry.status === "ready") {
    return buildModelSelection(entry.provider, label, entry.models ?? null);
  }
  if (entry.status === "loading") {
    return { kind: "loading" };
  }
  return {
    kind: "error",
    message: entry.error ?? (entry.status === "unavailable" ? "Unavailable" : "Unknown error"),
  };
}

export function buildProviderSelectorProviders(input: {
  providerDefinitions: AgentProviderDefinition[];
  modelsByProvider: Map<string, AgentModelDefinition[]>;
}): ProviderSelectorProvider[] {
  return input.providerDefinitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    modelSelection: buildModelSelection(
      definition.id,
      definition.label,
      input.modelsByProvider.has(definition.id)
        ? (input.modelsByProvider.get(definition.id) ?? [])
        : null,
    ),
  }));
}

export function buildSelectableProviderSelectorProviders(
  entries: ProviderSnapshotEntry[] | undefined,
): ProviderSelectorProvider[] {
  return (entries ?? [])
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const label = entry.label ?? entry.provider;
      return {
        id: entry.provider,
        label,
        modelSelection: buildEntryModelSelection(entry, label),
      };
    });
}

export function getProviderModelRows(
  provider: ProviderSelectorProvider,
): ProviderSelectionModelRow[] {
  return provider.modelSelection.kind === "models" ? provider.modelSelection.rows : [];
}

export function getAllProviderModelRows(
  providers: ProviderSelectorProvider[],
): ProviderSelectionModelRow[] {
  return providers.flatMap(getProviderModelRows);
}

export function resolveSelectedModelLabel(input: {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  isLoading: boolean;
}): string {
  const selectedProvider = input.selectedProvider.trim();
  if (!selectedProvider) {
    return "Select model";
  }

  const provider = input.providers.find((entry) => entry.id === selectedProvider);
  if (!provider) {
    return input.isLoading ? "Loading..." : "Select model";
  }
  if (provider.modelSelection.kind === "loading") {
    return "Loading...";
  }
  if (provider.modelSelection.kind !== "models") {
    return "Select model";
  }

  const model = provider.modelSelection.rows.find((entry) => entry.modelId === input.selectedModel);
  const defaultModel = provider.modelSelection.rows.find((row) => row.isDefault);
  return (
    model?.modelLabel ??
    defaultModel?.modelLabel ??
    provider.modelSelection.rows[0]?.modelLabel ??
    "Select model"
  );
}

export function buildSelectedTriggerLabel(modelLabel: string): string {
  return modelLabel;
}

export function matchesModelSearch(
  row: ProviderSelectionModelRow,
  normalizedQuery: string,
): boolean {
  return scoreModelRow(row, normalizedQuery) !== null;
}

function getModelRowSearchFields(row: ProviderSelectionModelRow): string[] {
  return [row.modelLabel, row.modelId, row.providerLabel, row.description ?? ""];
}

export function scoreModelRow(row: ProviderSelectionModelRow, normalizedQuery: string) {
  return scoreTextFields(normalizedQuery, getModelRowSearchFields(row));
}

export function filterAndRankModelRows(
  rows: ProviderSelectionModelRow[],
  normalizedQuery: string,
): ProviderSelectionModelRow[] {
  if (!normalizedQuery) return rows;
  const scored = rows
    .map((row) => ({ row, score: scoreModelRow(row, normalizedQuery) }))
    .filter(
      (
        entry,
      ): entry is { row: ProviderSelectionModelRow; score: NonNullable<typeof entry.score> } =>
        Boolean(entry.score),
    );

  scored.sort((a, b) => {
    const cmp = compareMatchScores(a.score, b.score);
    if (cmp !== 0) return cmp;
    return a.row.modelLabel.localeCompare(b.row.modelLabel);
  });

  return scored.map((entry) => entry.row);
}

export function resolveEffectiveComposerModelId(selection: ProviderSelectionState): string {
  return selection.modelId.trim();
}

export function resolveEffectiveComposerThinkingOptionId(
  selection: ProviderSelectionState,
  effectiveModelId: string,
): string {
  const selectedThinkingOptionId = selection.thinkingOptionId.trim();
  if (selectedThinkingOptionId) {
    return selectedThinkingOptionId;
  }

  const selectedModelDefinition =
    selection.availableModels.find((model) => model.id === effectiveModelId) ?? null;
  return selectedModelDefinition?.defaultThinkingOptionId ?? "";
}

export function buildDraftCommandConfig(input: {
  selection: ProviderSelectionState;
  cwd: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues?: Record<string, unknown>;
}): DraftCommandConfig | undefined {
  const cwd = input.cwd.trim();
  if (!input.selection.provider || !cwd) {
    return undefined;
  }

  return {
    provider: input.selection.provider,
    cwd,
    ...(input.selection.modeOptions.length > 0 && input.selection.modeId !== ""
      ? { modeId: input.selection.modeId }
      : {}),
    ...(input.effectiveModelId ? { model: input.effectiveModelId } : {}),
    ...(input.effectiveThinkingOptionId
      ? { thinkingOptionId: input.effectiveThinkingOptionId }
      : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}

export function resolveSubmissionReadiness(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  providerCount: number;
  selection: {
    provider: AgentProvider | string | null;
    modelId: string;
    availableModels: readonly unknown[];
    isModelLoading: boolean;
  };
  autoSubmitConfig: { provider: string; model: string | null } | null;
  workspaceDirectory: string | null;
  hasClient: boolean;
}): ProviderSelectionReadiness {
  if (!input.allowsEmptyAutoSubmit && !input.text.trim()) {
    return { ok: false, reason: "Initial prompt is required" };
  }
  if (input.providerCount === 0) {
    return { ok: false, reason: "No available providers on the selected host" };
  }
  if (!(input.autoSubmitConfig?.provider ?? input.selection.provider)) {
    return { ok: false, reason: "Select a model" };
  }
  if (input.selection.isModelLoading) {
    return { ok: false, reason: "Model defaults are still loading" };
  }
  const hasSelectedModel = Boolean(input.autoSubmitConfig?.model ?? input.selection.modelId);
  if (!hasSelectedModel && input.selection.availableModels.length > 0) {
    return { ok: false, reason: "No model is available for the selected provider" };
  }
  if (!input.workspaceDirectory) {
    return { ok: false, reason: "Workspace directory not found" };
  }
  if (!input.hasClient) {
    return { ok: false, reason: "Host is not connected" };
  }
  return { ok: true };
}
