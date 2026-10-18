import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  StructuredGenerationLogger,
  StructuredGenerationProvider,
} from "./agent-response-loop.js";
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
    { modelSubstring: "minimax-m3" },
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
  /**
   * Providers of the agents whose words the prompt carries: a new workspace's first agent, or
   * the agents working in a checkout. A custom provider among them is the only one tried, since
   * a custom provider is how the user picks where their prompts go (a zero-retention endpoint,
   * another account). Two different custom providers leave nothing to try: neither is the
   * user's pick for the other agent's words. Without one, every candidate is tried as before.
   */
  sourceProviders?: ReadonlyArray<AgentProvider | null | undefined>;
  logger?: Pick<StructuredGenerationLogger, "warn">;
}

/** An agent's selection as the last candidate: what it runs now, else what it was created with. */
export function readAgentGenerationSelection(
  agent: Pick<ManagedAgent, "provider" | "config" | "runtimeInfo">,
): NonNullable<ResolveStructuredGenerationProvidersOptions["currentSelection"]> {
  return {
    provider: agent.provider,
    model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
    thinkingOptionId: agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
  };
}

export async function resolveStructuredGenerationProviders(
  options: ResolveStructuredGenerationProvidersOptions,
): Promise<StructuredGenerationProvider[]> {
  const configuredProviders = readConfiguredProviders(options.daemonConfig);
  const providerEntries = await options.providerSnapshotManager.listProviders({
    cwd: options.cwd,
    wait: true,
  });
  const enabledEntries = providerEntries.filter((entry) => entry.enabled);
  const modelEntries = enabledEntries.filter((entry) => (entry.models?.length ?? 0) > 0);
  const entriesByProvider = new Map(enabledEntries.map((entry) => [entry.provider, entry]));
  const customSourceProviders = readCustomSourceProviders(options.sourceProviders, providerEntries);
  if (customSourceProviders.length > 1) {
    options.logger?.warn(
      { providers: customSourceProviders },
      "Structured generation skipped: agents on different custom providers",
    );
    return [];
  }
  const pinnedProvider = customSourceProviders[0];
  if (pinnedProvider) {
    if (!entriesByProvider.has(pinnedProvider)) {
      const configured = providerEntries.some((entry) => entry.provider === pinnedProvider);
      options.logger?.warn(
        { provider: pinnedProvider, reason: configured ? "disabled" : "not configured" },
        "Structured generation skipped: custom provider unavailable",
      );
      return [];
    }
    return resolvePinnedProviders({
      pinnedProvider,
      configuredProviders,
      currentSelection: options.currentSelection,
      modelEntries,
      entriesByProvider,
    });
  }
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

function readCustomSourceProviders(
  sourceProviders: ResolveStructuredGenerationProvidersOptions["sourceProviders"],
  providerEntries: readonly ProviderSnapshotEntry[],
): AgentProvider[] {
  const customProviders = new Set<AgentProvider>();
  for (const sourceProvider of sourceProviders ?? []) {
    const provider = sourceProvider?.trim();
    if (!provider) {
      continue;
    }
    // The snapshot lists every configured provider, so one it lacks was removed from the
    // config while an agent still runs on it: it pins too, and nothing runs.
    const entry = providerEntries.find((candidate) => candidate.provider === provider);
    if (!entry || entry.source === "custom") {
      customProviders.add(provider);
    }
  }
  return Array.from(customProviders);
}

/**
 * The usual order kept to one enabled provider: its configured entries, the defaults matched
 * within its own models, then the current selection, or the provider's default model when the
 * selection is another provider's. It has its own loop because the default matching picks the
 * first provider with a matching model, which would be a built-in one.
 */
function resolvePinnedProviders(input: {
  pinnedProvider: AgentProvider;
  configuredProviders: ReturnType<typeof readConfiguredProviders>;
  currentSelection: ResolveStructuredGenerationProvidersOptions["currentSelection"];
  modelEntries: readonly ProviderSnapshotEntry[];
  entriesByProvider: ReadonlyMap<AgentProvider, ProviderSnapshotEntry>;
}): StructuredGenerationProvider[] {
  const { pinnedProvider, modelEntries, entriesByProvider } = input;
  const pinnedEntries = modelEntries.filter((entry) => entry.provider === pinnedProvider);
  const providers: StructuredGenerationProvider[] = [];

  for (const configured of input.configuredProviders) {
    const resolved = resolveConfiguredCandidate(configured, modelEntries, entriesByProvider);
    if (resolved) {
      providers.push(resolved);
    }
  }

  for (const identifier of DEFAULT_STRUCTURED_GENERATION_PROVIDERS) {
    const resolved = resolveByModelSubstring(pinnedEntries, identifier);
    if (resolved) {
      providers.push(resolved);
    }
  }

  const selection =
    input.currentSelection?.provider?.trim() === pinnedProvider
      ? input.currentSelection
      : { provider: pinnedProvider };
  const resolvedSelection = resolveCurrentSelection(selection, modelEntries, entriesByProvider);
  if (resolvedSelection) {
    providers.push(resolvedSelection);
  }

  return dedupeProviders(providers.filter((provider) => provider.provider === pinnedProvider));
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
