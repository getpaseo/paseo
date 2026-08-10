import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";

export const CUSTOM_MODEL_METADATA_SOURCE_ID = "custom";

export interface ModelsDevCandidateLike {
  providerId: string;
  matchedId: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
}

export interface CustomModelFieldSnapshot {
  label: string;
  contextWindow: string;
  maxOutput: string;
}

export interface CustomModelFormFields {
  modelId: string;
  label: string;
  contextWindow: string;
  maxOutput: string;
  sourceId: string;
  summary: ModelsDevCandidateLike | null;
}

export function candidateSourceId(
  candidate: Pick<ModelsDevCandidateLike, "providerId" | "matchedId">,
): string {
  return `${candidate.providerId}\0${candidate.matchedId}`;
}

export function parsePositiveTokenInput(value: string): number | undefined | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    return "invalid";
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "invalid";
  }
  return Math.trunc(parsed);
}

export function formatTokenCount(tokens: number | undefined): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
    return null;
  }
  if (tokens % 1000 === 0) {
    const thousands = tokens / 1000;
    if (thousands % 1000 === 0) {
      return `${thousands / 1000}M`;
    }
    return `${thousands}k`;
  }
  return String(tokens);
}

export function canAutofillField(current: string, lastAutofilled: string | null): boolean {
  const trimmed = current.trim();
  return trimmed.length === 0 || trimmed === (lastAutofilled ?? "");
}

function nextAutofilledValue(
  current: string,
  lastAutofilled: string,
  next: string,
): { value: string; lastAutofilled: string } {
  if (!canAutofillField(current, lastAutofilled)) {
    return { value: current, lastAutofilled };
  }
  return { value: next, lastAutofilled: next };
}

export function applyCandidateToFields(
  candidate: ModelsDevCandidateLike,
  current: CustomModelFieldSnapshot,
  lastAutofilled: CustomModelFieldSnapshot,
): {
  next: CustomModelFieldSnapshot;
  lastAutofilled: CustomModelFieldSnapshot;
} {
  const labelResult = candidate.name
    ? nextAutofilledValue(current.label, lastAutofilled.label, candidate.name)
    : { value: current.label, lastAutofilled: lastAutofilled.label };
  const contextResult = nextAutofilledValue(
    current.contextWindow,
    lastAutofilled.contextWindow,
    String(candidate.contextWindowMaxTokens),
  );
  const maxOutputResult =
    typeof candidate.maxOutputTokens === "number"
      ? nextAutofilledValue(
          current.maxOutput,
          lastAutofilled.maxOutput,
          String(candidate.maxOutputTokens),
        )
      : { value: current.maxOutput, lastAutofilled: lastAutofilled.maxOutput };

  return {
    next: {
      label: labelResult.value,
      contextWindow: contextResult.value,
      maxOutput: maxOutputResult.value,
    },
    lastAutofilled: {
      label: labelResult.lastAutofilled,
      contextWindow: contextResult.lastAutofilled,
      maxOutput: maxOutputResult.lastAutofilled,
    },
  };
}

export function pickPreferredCandidate(
  candidates: ModelsDevCandidateLike[],
  preferredProviderId?: string | null,
): ModelsDevCandidateLike | null {
  if (candidates.length === 0) {
    return null;
  }
  if (preferredProviderId) {
    const preferred = candidates.find((candidate) => candidate.providerId === preferredProviderId);
    if (preferred) {
      return preferred;
    }
  }
  return candidates[0] ?? null;
}

export function describeCandidateOption(candidate: ModelsDevCandidateLike): {
  id: string;
  label: string;
  description: string;
} {
  const context =
    formatTokenCount(candidate.contextWindowMaxTokens) ?? String(candidate.contextWindowMaxTokens);
  const maxOutput =
    typeof candidate.maxOutputTokens === "number"
      ? (formatTokenCount(candidate.maxOutputTokens) ?? String(candidate.maxOutputTokens))
      : "—";
  return {
    id: candidateSourceId(candidate),
    label: candidate.providerId,
    description: `${context} context · ${maxOutput} max output`,
  };
}

function hasSummaryMetadata(model: ProviderProfileModel): boolean {
  if (typeof model.contextWindowMaxTokens === "number") {
    return true;
  }
  if (typeof model.maxOutputTokens === "number") {
    return true;
  }
  if ((model.inputModalities?.length ?? 0) > 0) {
    return true;
  }
  if ((model.outputModalities?.length ?? 0) > 0) {
    return true;
  }
  return (model.capabilities?.length ?? 0) > 0;
}

function summaryFromModel(model: ProviderProfileModel): ModelsDevCandidateLike {
  return {
    providerId: model.modelsDevProviderId ?? CUSTOM_MODEL_METADATA_SOURCE_ID,
    matchedId: model.modelsDevMatchedId ?? model.id,
    contextWindowMaxTokens: model.contextWindowMaxTokens ?? 0,
    ...(typeof model.maxOutputTokens === "number"
      ? { maxOutputTokens: model.maxOutputTokens }
      : {}),
    ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
    ...(model.outputModalities ? { outputModalities: model.outputModalities } : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
  };
}

export function resolveCustomModelFormFields(
  mode: { kind: "add" } | { kind: "edit"; model: ProviderProfileModel },
): CustomModelFormFields {
  if (mode.kind !== "edit") {
    return {
      modelId: "",
      label: "",
      contextWindow: "",
      maxOutput: "",
      sourceId: CUSTOM_MODEL_METADATA_SOURCE_ID,
      summary: null,
    };
  }

  const model = mode.model;
  const hasSavedSource =
    Boolean(model.modelsDevProviderId) &&
    model.modelsDevProviderId !== CUSTOM_MODEL_METADATA_SOURCE_ID;
  const sourceId = hasSavedSource
    ? candidateSourceId({
        providerId: model.modelsDevProviderId!,
        matchedId: model.modelsDevMatchedId ?? model.id,
      })
    : CUSTOM_MODEL_METADATA_SOURCE_ID;

  return {
    modelId: model.id,
    label: model.label === model.id ? "" : model.label,
    contextWindow:
      typeof model.contextWindowMaxTokens === "number" ? String(model.contextWindowMaxTokens) : "",
    maxOutput: typeof model.maxOutputTokens === "number" ? String(model.maxOutputTokens) : "",
    sourceId,
    summary: hasSummaryMetadata(model) ? summaryFromModel(model) : null,
  };
}

export function buildSavedCustomModel(options: {
  id: string;
  label: string;
  contextTokens: number | undefined;
  maxOutputTokens: number | undefined;
  sourceId: string;
  selectedCandidate: ModelsDevCandidateLike | null;
}): ProviderProfileModel {
  const nextModel: ProviderProfileModel = {
    id: options.id,
    label: options.label,
  };
  if (options.contextTokens !== undefined) {
    nextModel.contextWindowMaxTokens = options.contextTokens;
  }
  if (options.maxOutputTokens !== undefined) {
    nextModel.maxOutputTokens = options.maxOutputTokens;
  }

  if (options.sourceId === CUSTOM_MODEL_METADATA_SOURCE_ID) {
    nextModel.modelsDevProviderId = CUSTOM_MODEL_METADATA_SOURCE_ID;
    return nextModel;
  }

  const selected = options.selectedCandidate;
  if (!selected) {
    return nextModel;
  }

  nextModel.modelsDevProviderId = selected.providerId;
  nextModel.modelsDevMatchedId = selected.matchedId;
  if (selected.inputModalities) {
    nextModel.inputModalities = selected.inputModalities;
  }
  if (selected.outputModalities) {
    nextModel.outputModalities = selected.outputModalities;
  }
  if (selected.capabilities) {
    nextModel.capabilities = selected.capabilities;
  }
  return nextModel;
}

export function candidatesFromLookupResult(result: {
  providerId?: string;
  matchedId?: string;
  name?: string;
  contextWindowMaxTokens: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
  candidates?: ModelsDevCandidateLike[];
  query: string;
}): ModelsDevCandidateLike[] {
  if (result.candidates && result.candidates.length > 0) {
    return result.candidates;
  }
  return [
    {
      providerId: result.providerId ?? "models.dev",
      matchedId: result.matchedId ?? result.query,
      ...(result.name ? { name: result.name } : {}),
      contextWindowMaxTokens: result.contextWindowMaxTokens,
      ...(result.maxOutputTokens !== undefined ? { maxOutputTokens: result.maxOutputTokens } : {}),
      ...(result.inputModalities ? { inputModalities: result.inputModalities } : {}),
      ...(result.outputModalities ? { outputModalities: result.outputModalities } : {}),
      ...(result.capabilities ? { capabilities: result.capabilities } : {}),
    },
  ];
}

export interface ModelsDevLookupClient {
  getLastServerInfoMessage?: () => { features?: { modelsDevLookup?: boolean } } | null | undefined;
  lookupModelsDevModel?: (modelId: string) => Promise<{
    found: boolean;
    modelId: string;
    matchedId?: string;
    name?: string;
    contextWindowMaxTokens?: number;
    maxOutputTokens?: number;
    providerId?: string;
    inputModalities?: string[];
    outputModalities?: string[];
    capabilities?: string[];
    candidates?: ModelsDevCandidateLike[];
    error?: string | null;
  }>;
}

export async function resolveCustomModelLookup(options: {
  client: ModelsDevLookupClient;
  modelId: string;
  preferredProviderId?: string;
}): Promise<{
  kind: "missing" | "found";
  candidates: ModelsDevCandidateLike[];
  preferred: ModelsDevCandidateLike | null;
}> {
  const supportsLookup =
    options.client.getLastServerInfoMessage?.()?.features?.modelsDevLookup === true;
  if (!supportsLookup || typeof options.client.lookupModelsDevModel !== "function") {
    return { kind: "missing", candidates: [], preferred: null };
  }

  const result = await options.client.lookupModelsDevModel(options.modelId);
  if (!result.found || typeof result.contextWindowMaxTokens !== "number") {
    return { kind: "missing", candidates: [], preferred: null };
  }

  const candidates = candidatesFromLookupResult({
    providerId: result.providerId,
    matchedId: result.matchedId,
    name: result.name,
    contextWindowMaxTokens: result.contextWindowMaxTokens,
    maxOutputTokens: result.maxOutputTokens,
    inputModalities: result.inputModalities,
    outputModalities: result.outputModalities,
    capabilities: result.capabilities,
    candidates: result.candidates,
    query: options.modelId,
  });
  return {
    kind: "found",
    candidates,
    preferred: pickPreferredCandidate(candidates, options.preferredProviderId),
  };
}
