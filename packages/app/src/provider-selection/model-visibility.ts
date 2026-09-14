import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import type { ProviderSelectionModelRow, ModelVisibilitySelection } from "./provider-selection";

/**
 * Per-provider presentation preference keyed by exact model ID. Absent means
 * visible, so a fresh host and every newly discovered model start visible.
 *
 * Visibility is not `isSelectable`. `isSelectable` describes what the provider
 * can run; this describes what the user wants to see in a picker. Hidden models
 * stay in the catalog for labels, thinking options, validation, saved profiles,
 * running agents and the CLI/API.
 */
export type ProviderModelVisibility = Record<string, boolean>;

export type ModelVisibilityByProvider = Record<string, ProviderModelVisibility>;

export function isModelVisible(
  visibility: ProviderModelVisibility | undefined,
  modelId: string,
): boolean {
  if (!visibility) return true;
  return visibility[modelId] !== false;
}

export function filterVisibleModels(
  models: AgentModelDefinition[] | null,
  visibility: ProviderModelVisibility | undefined,
): AgentModelDefinition[] | null {
  if (!models) return null;
  if (!visibility) return models;
  return models.filter((model) => isModelVisible(visibility, model.id));
}

export function filterVisibleModelRows(
  rows: ProviderSelectionModelRow[],
  visibilityByProvider: ModelVisibilityByProvider | undefined,
): ProviderSelectionModelRow[] {
  if (!visibilityByProvider) return rows;
  return rows.filter((row) => {
    // The synthetic "Default" row has no model ID and cannot be hidden.
    if (row.modelId === "") return true;
    return isModelVisible(visibilityByProvider[row.provider], row.modelId);
  });
}

/**
 * Distinguishes "this provider discovered nothing" from "every discovered model
 * is hidden". The first keeps the pre-existing empty-catalog behaviour, where an
 * unset model lets the daemon pick its own default. The second must never
 * resolve to a model, and must not let a fresh launch submit an empty model
 * either, or the daemon default would silently reinstate a hidden model.
 */
export type VisibleModelCandidates =
  | { kind: "models"; models: AgentModelDefinition[] }
  | { kind: "loading" }
  | { kind: "empty-catalog" }
  | { kind: "all-hidden" };

export function resolveVisibleModelCandidates(
  models: AgentModelDefinition[] | null,
  visibility: ProviderModelVisibility | undefined,
): VisibleModelCandidates {
  if (!models) return { kind: "loading" };
  if (models.length === 0) return { kind: "empty-catalog" };
  const visible = filterVisibleModels(models, visibility) ?? [];
  if (visible.length === 0) return { kind: "all-hidden" };
  return { kind: "models", models: visible };
}

/**
 * Candidate list for resolving a *fresh* default only. `null` means "do not pick
 * anything", which callers already treat as an unset model.
 */
export function resolveDefaultModelCandidates(
  models: AgentModelDefinition[] | null,
  visibility: ProviderModelVisibility | undefined,
): AgentModelDefinition[] | null {
  const candidates = resolveVisibleModelCandidates(models, visibility);
  switch (candidates.kind) {
    case "models":
      return candidates.models;
    case "empty-catalog":
      return models;
    case "all-hidden":
    case "loading":
      return null;
  }
}

export function areAllModelsHidden(
  models: AgentModelDefinition[] | null,
  visibility: ProviderModelVisibility | undefined,
): boolean {
  return resolveVisibleModelCandidates(models, visibility).kind === "all-hidden";
}

export function buildModelVisibilityByProvider(
  providers: Record<string, { modelVisibility?: ProviderModelVisibility } | undefined> | undefined,
): ModelVisibilityByProvider {
  const result: ModelVisibilityByProvider = {};
  for (const [providerId, providerConfig] of Object.entries(providers ?? {})) {
    const visibility = providerConfig?.modelVisibility;
    if (visibility && Object.keys(visibility).length > 0) {
      result[providerId] = visibility;
    }
  }
  return result;
}

export function isModelVisibilitySupported(
  info: { features?: Record<string, boolean>; permissions?: readonly string[] } | null | undefined,
): boolean {
  return (
    info?.features?.modelVisibility === true && (info.permissions?.includes("daemon.read") ?? true)
  );
}

export async function setModelVisible(input: {
  provider: string;
  modelId: string;
  visible: boolean;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<MutableDaemonConfig | undefined>;
  disconnectedMessage: string;
}): Promise<void> {
  const result = await input.patchConfig({
    providers: { [input.provider]: { modelVisibility: { [input.modelId]: input.visible } } },
  });
  if (!result) throw new Error(input.disconnectedMessage);
}

/**
 * A config the query already delivered wins over a later fetch failure: that is
 * the acknowledged state for this session, so a dropped refresh does not throw
 * the picker back into an error.
 */
export function resolveVisibilityStatus(input: {
  isSupported: boolean;
  hasConfig: boolean;
  isError: boolean;
}): ModelVisibilitySelection["status"] {
  if (!input.isSupported) return "unavailable";
  if (input.hasConfig) return "ready";
  if (input.isError) return "error";
  return "loading";
}

/**
 * One Retry, two possible causes. A picker's Retry button is the only recovery
 * affordance the user has, and a visibility-fetch failure looks exactly like a
 * discovery failure from the outside. Retrying discovery alone would succeed and
 * change nothing, leaving the selector stuck.
 */
export function retryModelSelection(input: {
  status: ModelVisibilitySelection["status"];
  retryVisibility: () => void;
  refreshDiscovery: () => void;
}): void {
  if (input.status === "error") {
    input.retryVisibility();
  }
  input.refreshDiscovery();
}
