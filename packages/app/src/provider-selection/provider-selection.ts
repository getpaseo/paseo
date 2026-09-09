import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import { i18n } from "@/i18n/i18next";
import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { filterSelectableModels } from "./model-catalog";
import { filterVisibleModelRows, type ModelVisibilityByProvider } from "./model-visibility";

export interface ProviderSelectionModelRow {
  /**
   * Row identity — `provider:modelId`. Used as the React key and as the row's
   * stable handle across list rebuilds. The name is historical; it has nothing
   * to do with the removed favourites feature.
   */
  favoriteKey: string;
  provider: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  description?: string;
  isDefault?: boolean;
}

function buildModelRowKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** The minimum a model needs to supply a display label. */
export interface ModelLabelSource {
  id: string;
  label: string;
}

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
  /** Full selectable catalog. Keeps labels, thinking options and validation working for hidden models. */
  availableModels: AgentModelDefinition[];
  /**
   * Models the user has not hidden. Only fresh defaults read this; omit it and
   * the whole catalog is treated as visible.
   */
  visibleModels?: AgentModelDefinition[];
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
    favoriteKey: buildModelRowKey(provider, model.id),
    provider,
    providerLabel,
    modelId: model.id,
    modelLabel: model.label,
    description: model.description ?? model.id,
    isDefault: model.isDefault,
  }));
}

function buildSyntheticDefaultRow(
  provider: string,
  providerLabel: string,
): ProviderSelectionModelRow {
  return {
    favoriteKey: buildModelRowKey(provider, ""),
    provider,
    providerLabel,
    modelId: "",
    modelLabel: i18n.t("providerSelection.defaultModel"),
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
  const selectableModels = filterSelectableModels(models) ?? [];
  if (selectableModels.length === 0) {
    return { kind: "models", rows: [buildSyntheticDefaultRow(provider, providerLabel)] };
  }
  return { kind: "models", rows: buildModelRows(provider, providerLabel, selectableModels) };
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
    message:
      entry.error ??
      (entry.status === "unavailable"
        ? i18n.t("providerSelection.unavailable")
        : i18n.t("providerSelection.unknownError")),
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
  /**
   * Every model the provider knows, pickable or not. `providers` carries only
   * the rows the user can pick, so without this a hidden current model would
   * lose its label and read as a raw ID.
   */
  catalogModels?: readonly ModelLabelSource[] | null;
}): string {
  const selectedProvider = input.selectedProvider.trim();
  if (!selectedProvider) {
    return input.isLoading
      ? i18n.t("providerSelection.loading")
      : i18n.t("providerSelection.selectModel");
  }

  const provider = input.providers.find((entry) => entry.id === selectedProvider);
  if (!provider) {
    return input.isLoading
      ? i18n.t("providerSelection.loading")
      : i18n.t("providerSelection.selectModel");
  }
  if (provider.modelSelection.kind === "loading") {
    return i18n.t("providerSelection.loading");
  }
  if (provider.modelSelection.kind === "error") {
    return i18n.t("providerSelection.error");
  }
  if (provider.modelSelection.kind !== "models") {
    return i18n.t("providerSelection.selectModel");
  }

  const model = provider.modelSelection.rows.find((entry) => entry.modelId === input.selectedModel);
  const selectedModel = input.selectedModel.trim();
  if (!model && selectedModel) {
    return input.catalogModels?.find((entry) => entry.id === selectedModel)?.label ?? selectedModel;
  }
  const defaultModel = provider.modelSelection.rows.find((row) => row.isDefault);
  return (
    model?.modelLabel ??
    defaultModel?.modelLabel ??
    provider.modelSelection.rows[0]?.modelLabel ??
    i18n.t("providerSelection.selectModel")
  );
}

export function buildSelectedTriggerLabel(modelLabel: string): string {
  return modelLabel;
}

/**
 * Cross-provider result rows need the provider named up front: the same model
 * label ships on several providers at once.
 */
export function buildProviderQualifiedDescription(row: ProviderSelectionModelRow): string {
  return row.description ? `${row.providerLabel} · ${row.description}` : row.providerLabel;
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
  const selectedModelId = selection.modelId.trim();
  if (selectedModelId) {
    return selectedModelId;
  }
  // Falling back through the full catalog would launch a model the user hid, so
  // the implicit default is drawn from the visible ones.
  const candidates = selection.visibleModels ?? selection.availableModels;
  return candidates.find((model) => model.isDefault)?.id ?? candidates[0]?.id ?? "";
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
    /** Every discovered model is hidden, so there is nothing valid to launch. */
    allModelsHidden?: boolean;
  };
  autoSubmitConfig: { provider: string; model: string | null } | null;
  workspaceDirectory: string | null;
  hasClient: boolean;
}): ProviderSelectionReadiness {
  if (!input.allowsEmptyAutoSubmit && !input.text.trim()) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.initialPromptRequired") };
  }
  if (input.providerCount === 0) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.noProviders") };
  }
  if (!(input.autoSubmitConfig?.provider ?? input.selection.provider)) {
    return { ok: false, reason: i18n.t("providerSelection.selectModel") };
  }
  if (input.selection.isModelLoading) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.modelDefaultsLoading") };
  }
  const hasSelectedModel = Boolean(input.autoSubmitConfig?.model ?? input.selection.modelId);
  // Hiding every model stops new implicit choices. It does not revoke a model
  // the user explicitly chose or a profile they applied, so an existing
  // selection still sends.
  if (!hasSelectedModel && input.selection.allModelsHidden) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.allModelsHidden") };
  }
  if (!hasSelectedModel && input.selection.availableModels.length > 0) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.noModelAvailable") };
  }
  if (!input.workspaceDirectory) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.workspaceDirectoryNotFound") };
  }
  if (!input.hasClient) {
    return { ok: false, reason: i18n.t("providerSelection.readiness.hostDisconnected") };
  }
  return { ok: true };
}

/**
 * What the picker knows about this host's hidden models.
 *
 * `unavailable` is an old daemon or a session without `daemon.read`: the picker
 * keeps its pre-feature rows. `loading` and `error` mean the host does support
 * the preference but has not told us what it is, so showing the unfiltered list
 * would flash models the user hid.
 */
export interface ModelVisibilitySelection {
  status: "unavailable" | "loading" | "error" | "ready";
  visibilityByProvider: ModelVisibilityByProvider | undefined;
}

/**
 * The one place selector rows lose hidden models. Producers that build their own
 * choice lists call this rather than re-deriving the rule.
 */
export function applyModelVisibilityToProviders(
  providers: ProviderSelectorProvider[],
  selection: ModelVisibilitySelection | undefined,
): ProviderSelectorProvider[] {
  if (!selection || selection.status === "unavailable") return providers;
  if (selection.status === "loading") {
    return providers.map((provider) =>
      provider.modelSelection.kind === "models"
        ? { ...provider, modelSelection: { kind: "loading" } }
        : provider,
    );
  }
  if (selection.status === "error") {
    return providers.map((provider) =>
      provider.modelSelection.kind === "models"
        ? {
            ...provider,
            modelSelection: {
              kind: "error",
              message: i18n.t("providerSelection.visibilityUnavailable"),
            },
          }
        : provider,
    );
  }
  const visibilityByProvider = selection.visibilityByProvider;
  if (!visibilityByProvider) return providers;
  return providers.map((provider) => {
    if (provider.modelSelection.kind !== "models") return provider;
    const rows = filterVisibleModelRows(provider.modelSelection.rows, visibilityByProvider);
    if (rows.length === provider.modelSelection.rows.length) return provider;
    return { ...provider, modelSelection: { kind: "models", rows } };
  });
}
