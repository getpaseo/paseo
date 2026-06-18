import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { StructuredGenerationProvider } from "./agent-response-loop.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

export interface StructuredGenerationDaemonConfig {
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
}

export interface StructuredGenerationProviderIdentifier {
  modelSubstring: string;
  thinkingOptionId?: string;
}

export const DEFAULT_STRUCTURED_GENERATION_PROVIDERS: readonly StructuredGenerationProviderIdentifier[] =
  [
    { modelSubstring: "haiku" },
    { modelSubstring: "gpt-5.4-mini", thinkingOptionId: "low" },
    { modelSubstring: "minimax-m2.5" },
    { modelSubstring: "nemotron-3-super" },
  ] as const;

export interface ResolveStructuredGenerationProvidersOptions {
  cwd: string;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  currentSelection?: {
    provider?: AgentProvider | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  };
}

export async function resolveStructuredGenerationProviders(
  options: ResolveStructuredGenerationProvidersOptions,
): Promise<StructuredGenerationProvider[]> {
  const configuredProviders = readConfiguredProviders(options.daemonConfig);
  if (configuredProviders.length > 0) {
    const explicitProviders = resolveExplicitConfiguredProviders(configuredProviders);
    if (explicitProviders.length === configuredProviders.length) {
      return dedupeProviders(explicitProviders);
    }

    const providerEntries = await options.providerSnapshotManager.listProviders({
      cwd: options.cwd,
      wait: false,
    });
    const providers = resolveConfiguredProviders(configuredProviders, providerEntries);
    if (providers.length > 0) {
      return dedupeProviders(providers);
    }
  }

  const providerEntries = await options.providerSnapshotManager.listProviders({
    cwd: options.cwd,
    wait: true,
  });
  const enabledEntries = providerEntries.filter((entry) => entry.enabled);
  const modelEntries = enabledEntries.filter((entry) => (entry.models?.length ?? 0) > 0);
  const entriesByProvider = new Map(enabledEntries.map((entry) => [entry.provider, entry]));
  const providers: StructuredGenerationProvider[] = [];

  for (const configured of configuredProviders) {
    const resolvedConfigured = resolveConfiguredCandidate(
      configured,
      modelEntries,
      entriesByProvider,
    );
    if (!resolvedConfigured) {
      continue;
    }
    providers.push(resolvedConfigured);
  }

  for (const identifier of DEFAULT_STRUCTURED_GENERATION_PROVIDERS) {
    const resolved = resolveByModelSubstring(modelEntries, identifier);
    if (resolved) {
      providers.push(resolved);
    }
  }

  const currentSelection = resolveCurrentSelection(
    options.currentSelection,
    modelEntries,
    entriesByProvider,
  );
  if (currentSelection) {
    providers.push(currentSelection);
  }

  return dedupeProviders(providers);
}

function resolveConfiguredProviders(
  configuredProviders: readonly { provider: string; model?: string; thinkingOptionId?: string }[],
  providerEntries: readonly ProviderSnapshotEntry[],
): StructuredGenerationProvider[] {
  const enabledEntries = providerEntries.filter((entry) => entry.enabled);
  const modelEntries = enabledEntries.filter((entry) => (entry.models?.length ?? 0) > 0);
  const entriesByProvider = new Map(enabledEntries.map((entry) => [entry.provider, entry]));
  const providers: StructuredGenerationProvider[] = [];
  for (const configured of configuredProviders) {
    const resolved = resolveConfiguredCandidate(configured, modelEntries, entriesByProvider);
    if (resolved) {
      providers.push(resolved);
    }
  }
  return providers;
}

function resolveExplicitConfiguredProviders(
  configuredProviders: readonly { provider: string; model?: string; thinkingOptionId?: string }[],
): StructuredGenerationProvider[] {
  const providers: StructuredGenerationProvider[] = [];
  for (const configured of configuredProviders) {
    const provider = configured.provider.trim();
    const model = configured.model?.trim();
    if (!provider || !model) {
      continue;
    }
    providers.push({
      provider,
      model,
      ...(configured.thinkingOptionId ? { thinkingOptionId: configured.thinkingOptionId } : {}),
    });
  }
  return providers;
}

function resolveCurrentSelection(
  selection: ResolveStructuredGenerationProvidersOptions["currentSelection"],
  readyEntries: readonly ProviderSnapshotEntry[],
  entriesByProvider: ReadonlyMap<AgentProvider, ProviderSnapshotEntry>,
): StructuredGenerationProvider | null {
  if (!selection) {
    return null;
  }

  const provider = selection.provider?.trim();
  if (!provider) {
    return null;
  }

  const normalized = resolveConfiguredCandidate(
    {
      provider,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
    },
    readyEntries,
    entriesByProvider,
  );
  if (normalized) {
    return normalized;
  }

  const explicitModel = selection.model?.trim();
  if (explicitModel) {
    return {
      provider,
      model: explicitModel,
      ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
    };
  }

  const model = selectDefaultModel(entriesByProvider.get(provider)?.models ?? []);
  if (!model) {
    return { provider };
  }

  const thinkingOptionId = resolveThinkingOptionId(model, selection.thinkingOptionId);
  return {
    provider,
    model: model.id,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

function resolveConfiguredCandidate(
  candidate: { provider: string; model?: string; thinkingOptionId?: string },
  readyEntries: readonly ProviderSnapshotEntry[],
  entriesByProvider: ReadonlyMap<AgentProvider, ProviderSnapshotEntry>,
): StructuredGenerationProvider | null {
  const provider = candidate.provider.trim();
  if (!provider) {
    return null;
  }

  const topLevelEntry = entriesByProvider.get(provider);
  const configuredModel = candidate.model?.trim();
  if (topLevelEntry) {
    if (configuredModel) {
      return {
        provider,
        model: configuredModel,
        ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
      };
    }

    const model = selectDefaultModel(topLevelEntry.models ?? []);
    const thinkingOptionId = resolveThinkingOptionId(model, candidate.thinkingOptionId);
    return {
      provider,
      ...(model ? { model: model.id } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }

  if (!configuredModel) {
    return {
      provider,
      ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
    };
  }

  const nestedMatch = resolveNestedProviderModel(provider, configuredModel, readyEntries);
  if (!nestedMatch) {
    return {
      provider,
      model: configuredModel,
      ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
    };
  }

  const thinkingOptionId = resolveThinkingOptionId(nestedMatch.model, candidate.thinkingOptionId);
  return {
    provider: nestedMatch.provider,
    model: nestedMatch.model.id,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

function resolveNestedProviderModel(
  providerId: string,
  modelId: string,
  entries: readonly ProviderSnapshotEntry[],
): { provider: AgentProvider; model: AgentModelDefinition } | null {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim().toLowerCase();

  for (const entry of entries) {
    for (const model of entry.models ?? []) {
      const modelProviderId = readModelMetadataString(model, "providerId")?.toLowerCase();
      const nestedModelId = readModelMetadataString(model, "modelId")?.toLowerCase();
      if (modelProviderId !== normalizedProviderId) {
        continue;
      }
      if (
        normalizedModelId === model.id.toLowerCase() ||
        normalizedModelId === nestedModelId ||
        model.id.toLowerCase() === `${normalizedProviderId}/${normalizedModelId}`
      ) {
        return { provider: entry.provider, model };
      }
    }
  }

  return null;
}

function resolveByModelSubstring(
  entries: readonly ProviderSnapshotEntry[],
  identifier: StructuredGenerationProviderIdentifier,
): StructuredGenerationProvider | null {
  const needle = identifier.modelSubstring.trim().toLowerCase();
  if (!needle) {
    return null;
  }

  for (const entry of entries) {
    for (const model of entry.models ?? []) {
      const haystacks = [model.id, model.label].map((value) => value.toLowerCase());
      if (!haystacks.some((value) => value.includes(needle))) {
        continue;
      }
      const thinkingOptionId = resolveThinkingOptionId(model, identifier.thinkingOptionId);
      return {
        provider: entry.provider,
        model: model.id,
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      };
    }
  }

  return null;
}

function readConfiguredProviders(
  daemonConfig: ResolveStructuredGenerationProvidersOptions["daemonConfig"],
): Array<{ provider: string; model?: string; thinkingOptionId?: string }> {
  const metadataGeneration = daemonConfig?.metadataGeneration;
  if (!metadataGeneration || typeof metadataGeneration !== "object") {
    return [];
  }
  const providers = "providers" in metadataGeneration ? metadataGeneration.providers : undefined;
  return Array.isArray(providers) ? providers : [];
}

function selectDefaultModel(models: readonly AgentModelDefinition[]): AgentModelDefinition | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

function resolveThinkingOptionId(
  model: AgentModelDefinition | null | undefined,
  preferredThinkingOptionId: string | null | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  if (
    preferredThinkingOptionId &&
    model.thinkingOptions?.some((option) => option.id === preferredThinkingOptionId)
  ) {
    return preferredThinkingOptionId;
  }
  return model.defaultThinkingOptionId;
}

function dedupeProviders(
  providers: readonly StructuredGenerationProvider[],
): StructuredGenerationProvider[] {
  const seen = new Set<string>();
  const deduped: StructuredGenerationProvider[] = [];

  for (const provider of providers) {
    const key = [provider.provider, provider.model ?? "", provider.thinkingOptionId ?? ""].join(
      "\0",
    );
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(provider);
  }

  return deduped;
}

function readModelMetadataString(model: AgentModelDefinition, key: string): string | undefined {
  const value = model.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
