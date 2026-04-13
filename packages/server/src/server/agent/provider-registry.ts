import type { Logger } from "pino";

import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRuntimeInfo,
  AgentSession,
  AgentStreamEvent,
  ListModelsOptions,
  ListModesOptions,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "./agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
  ProviderProfileModel,
  ProviderRuntimeSettings,
} from "./provider-launch-config.js";
import { ClaudeAgentClient } from "./providers/claude-agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { CopilotACPAgentClient } from "./providers/copilot-acp-agent.js";
import { GenericACPAgentClient } from "./providers/generic-acp-agent.js";
import { OpenCodeAgentClient, OpenCodeServerManager } from "./providers/opencode-agent.js";
import { PiACPAgentClient } from "./providers/pi-acp-agent.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  getAgentProviderDefinition,
  type AgentProviderDefinition,
} from "./provider-manifest.js";

export type { AgentProviderDefinition };

export { AGENT_PROVIDER_DEFINITIONS, getAgentProviderDefinition };

export interface ProviderDefinition extends AgentProviderDefinition {
  createClient: (logger: Logger) => AgentClient;
  fetchModels: (options?: ListModelsOptions) => Promise<AgentModelDefinition[]>;
  fetchModes: (options?: ListModesOptions) => Promise<AgentMode[]>;
}

export type BuildProviderRegistryOptions = {
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
};

type ProviderClientFactory = (
  logger: Logger,
  runtimeSettings?: ProviderRuntimeSettings,
) => AgentClient;

type ResolvedProvider = {
  definition: AgentProviderDefinition;
  runtimeSettings?: ProviderRuntimeSettings;
  profileModels: ProviderProfileModel[];
  enabled: boolean;
  createBaseClient: (logger: Logger) => AgentClient;
};

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  claude: (logger, runtimeSettings) =>
    new ClaudeAgentClient({
      logger,
      runtimeSettings,
    }),
  codex: (logger, runtimeSettings) => new CodexAppServerAgentClient(logger, runtimeSettings),
  copilot: (logger, runtimeSettings) =>
    new CopilotACPAgentClient({
      logger,
      runtimeSettings,
    }),
  opencode: (logger, runtimeSettings) => new OpenCodeAgentClient(logger, runtimeSettings),
  pi: (logger, runtimeSettings) =>
    new PiACPAgentClient({
      logger,
      runtimeSettings,
    }),
};

function getProviderClientFactory(provider: string): ProviderClientFactory {
  const factory = PROVIDER_CLIENT_FACTORIES[provider];
  if (!factory) {
    throw new Error(`No provider client factory registered for '${provider}'`);
  }
  return factory;
}

function toRuntimeSettings(override?: ProviderOverride): ProviderRuntimeSettings | undefined {
  if (!override?.command && !override?.env) {
    return undefined;
  }

  return {
    command: override.command
      ? {
          mode: "replace",
          argv: override.command,
        }
      : undefined,
    env: override.env,
  };
}

function mergeRuntimeSettings(
  base: ProviderRuntimeSettings | undefined,
  override: ProviderRuntimeSettings | undefined,
): ProviderRuntimeSettings | undefined {
  if (!base && !override) {
    return undefined;
  }

  return {
    command: override?.command ?? base?.command,
    env:
      base?.env || override?.env
        ? {
            ...(base?.env ?? {}),
            ...(override?.env ?? {}),
          }
        : undefined,
  };
}

function applyOverrideToDefinition(
  definition: AgentProviderDefinition,
  override?: ProviderOverride,
): AgentProviderDefinition {
  if (!override) {
    return definition;
  }

  return {
    ...definition,
    label: override.label ?? definition.label,
    description: override.description ?? definition.description,
  };
}

function createDerivedDefinition(
  providerId: string,
  baseDefinition: AgentProviderDefinition,
  override: ProviderOverride,
): AgentProviderDefinition {
  if (!override.label) {
    throw new Error(`Custom provider '${providerId}' requires a label`);
  }

  return {
    ...baseDefinition,
    id: providerId,
    label: override.label,
    description: override.description ?? baseDefinition.description,
  };
}

function mapPersistenceHandle(
  provider: AgentProvider,
  handle: AgentPersistenceHandle | null,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }

  return {
    ...handle,
    provider,
  };
}

function mapRuntimeInfo(provider: AgentProvider, runtimeInfo: AgentRuntimeInfo): AgentRuntimeInfo {
  return {
    ...runtimeInfo,
    provider,
  };
}

function mapStreamEvent(provider: AgentProvider, event: AgentStreamEvent): AgentStreamEvent {
  return {
    ...event,
    provider,
  };
}

function mapPersistedAgentDescriptor(
  provider: AgentProvider,
  descriptor: PersistedAgentDescriptor,
): PersistedAgentDescriptor {
  return {
    ...descriptor,
    provider,
    persistence: {
      ...descriptor.persistence,
      provider,
    },
  };
}

function mapModel(provider: AgentProvider, model: AgentModelDefinition): AgentModelDefinition {
  return {
    ...model,
    provider,
  };
}

function mergeModels(
  provider: AgentProvider,
  profileModels: ProviderProfileModel[],
  runtimeModels: AgentModelDefinition[],
): AgentModelDefinition[] {
  if (profileModels.length === 0) {
    return runtimeModels.map((model) => mapModel(provider, model));
  }

  return profileModels.map((model) => ({
    ...model,
    provider,
  }));
}

function wrapSessionProvider(provider: AgentProvider, inner: AgentSession): AgentSession {
  return {
    provider,
    id: inner.id,
    capabilities: inner.capabilities,
    get features() {
      return inner.features;
    },
    run: (prompt, options) => inner.run(prompt, options),
    startTurn: (prompt, options) => inner.startTurn(prompt, options),
    subscribe: (callback) => inner.subscribe((event) => callback(mapStreamEvent(provider, event))),
    async *streamHistory() {
      for await (const event of inner.streamHistory()) {
        yield mapStreamEvent(provider, event);
      }
    },
    getRuntimeInfo: async () => mapRuntimeInfo(provider, await inner.getRuntimeInfo()),
    getAvailableModes: () => inner.getAvailableModes(),
    getCurrentMode: () => inner.getCurrentMode(),
    setMode: (modeId) => inner.setMode(modeId),
    getPendingPermissions: () => inner.getPendingPermissions(),
    respondToPermission: (requestId, response) => inner.respondToPermission(requestId, response),
    describePersistence: () => mapPersistenceHandle(provider, inner.describePersistence()),
    interrupt: () => inner.interrupt(),
    close: () => inner.close(),
    listCommands: inner.listCommands?.bind(inner),
    setModel: inner.setModel?.bind(inner),
    setThinkingOption: inner.setThinkingOption?.bind(inner),
    setFeature: inner.setFeature?.bind(inner),
  };
}

function wrapClientProvider(provider: AgentProvider, inner: AgentClient): AgentClient {
  const listPersistedAgents = inner.listPersistedAgents?.bind(inner);

  return {
    provider,
    capabilities: inner.capabilities,
    createSession: async (config, launchContext) =>
      wrapSessionProvider(
        provider,
        await inner.createSession(
          {
            ...config,
            provider: inner.provider,
          },
          launchContext,
        ),
      ),
    resumeSession: async (handle, overrides, launchContext) =>
      wrapSessionProvider(
        provider,
        await inner.resumeSession(
          {
            ...handle,
            provider: inner.provider,
          },
          overrides
            ? {
                ...overrides,
                provider: inner.provider,
              }
            : undefined,
          launchContext,
        ),
      ),
    listModels: async (options) =>
      (await inner.listModels(options)).map((model) => mapModel(provider, model)),
    listModes: inner.listModes?.bind(inner),
    listPersistedAgents: listPersistedAgents
      ? async (options?: ListPersistedAgentsOptions) =>
          (await listPersistedAgents(options)).map((descriptor) =>
            mapPersistedAgentDescriptor(provider, descriptor),
          )
      : undefined,
    isAvailable: () => inner.isAvailable(),
    getDiagnostic: inner.getDiagnostic?.bind(inner),
  };
}

function createRegistryEntry(
  logger: Logger,
  provider: AgentProvider,
  resolved: ResolvedProvider,
): ProviderDefinition {
  const modelClient = resolved.createBaseClient(logger);

  return {
    ...resolved.definition,
    createClient: (providerLogger: Logger) => {
      const inner = resolved.createBaseClient(providerLogger);
      return inner.provider === provider ? inner : wrapClientProvider(provider, inner);
    },
    fetchModels: async (options?: ListModelsOptions) =>
      mergeModels(provider, resolved.profileModels, await modelClient.listModels(options)),
    fetchModes: async (options?: ListModesOptions) => {
      const modes = modelClient.listModes
        ? await modelClient.listModes(options)
        : resolved.definition.modes;
      return modes.map((mode) => {
        if (mode.icon && mode.colorTier) return mode;
        const definitionMode = resolved.definition.modes.find((d) => d.id === mode.id);
        if (!definitionMode) return mode;
        return {
          ...mode,
          icon: mode.icon ?? definitionMode.icon,
          colorTier: mode.colorTier ?? definitionMode.colorTier,
        };
      });
    },
  };
}

function buildResolvedBuiltinProviders(
  providerOverrides: Record<string, ProviderOverride>,
  runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
): Map<string, ResolvedProvider> {
  const resolvedProviders = new Map<string, ResolvedProvider>();

  for (const definition of AGENT_PROVIDER_DEFINITIONS) {
    const override = providerOverrides[definition.id];
    const factory = getProviderClientFactory(definition.id);
    const mergedRuntimeSettings = mergeRuntimeSettings(
      runtimeSettings?.[definition.id],
      toRuntimeSettings(override),
    );

    resolvedProviders.set(definition.id, {
      definition: applyOverrideToDefinition(definition, override),
      runtimeSettings: mergedRuntimeSettings,
      profileModels: override?.models ?? [],
      enabled: override?.enabled !== false,
      createBaseClient: (logger) => factory(logger, mergedRuntimeSettings),
    });
  }

  return resolvedProviders;
}

function addDerivedProviders(
  resolvedProviders: Map<string, ResolvedProvider>,
  providerOverrides: Record<string, ProviderOverride>,
): void {
  for (const [providerId, override] of Object.entries(providerOverrides)) {
    if (BUILTIN_PROVIDER_IDS.includes(providerId)) {
      continue;
    }

    if (!override.extends) {
      throw new Error(`Custom provider '${providerId}' requires an extends value`);
    }

    if (override.extends === "acp") {
      if (!override.command) {
        throw new Error(`ACP provider '${providerId}' requires a command`);
      }

      resolvedProviders.set(providerId, {
        definition: createDerivedDefinition(
          providerId,
          {
            id: providerId,
            label: override.label ?? providerId,
            description: override.description ?? "Custom ACP provider",
            defaultModeId: null,
            modes: [],
          },
          override,
        ),
        runtimeSettings: toRuntimeSettings(override),
        profileModels: override.models ?? [],
        enabled: override.enabled !== false,
        createBaseClient: (logger) =>
          new GenericACPAgentClient({
            logger,
            command: override.command!,
            env: override.env,
          }),
      });
      continue;
    }

    const baseProvider = resolvedProviders.get(override.extends);
    if (!baseProvider) {
      throw new Error(
        `Custom provider '${providerId}' extends unknown provider '${override.extends}'`,
      );
    }

    const mergedRuntimeSettings = mergeRuntimeSettings(
      baseProvider.runtimeSettings,
      toRuntimeSettings(override),
    );
    const baseDefinition = baseProvider.definition;
    const baseFactory = getProviderClientFactory(override.extends);

    resolvedProviders.set(providerId, {
      definition: createDerivedDefinition(providerId, baseDefinition, override),
      runtimeSettings: mergedRuntimeSettings,
      profileModels: override.models ?? [],
      enabled: override.enabled !== false,
      createBaseClient: (logger) => baseFactory(logger, mergedRuntimeSettings),
    });
  }
}

export function buildProviderRegistry(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, ProviderDefinition> {
  const runtimeSettings = options?.runtimeSettings;
  const providerOverrides = options?.providerOverrides ?? {};
  const resolvedProviders = buildResolvedBuiltinProviders(providerOverrides, runtimeSettings);
  addDerivedProviders(resolvedProviders, providerOverrides);

  return Object.fromEntries(
    [...resolvedProviders.entries()]
      .filter(([, resolved]) => resolved.enabled)
      .map(([provider, resolved]) => [provider, createRegistryEntry(logger, provider, resolved)]),
  ) as Record<AgentProvider, ProviderDefinition>;
}

export function getProviderIds(
  registry: Record<AgentProvider, ProviderDefinition>,
): AgentProvider[] {
  return Object.keys(registry);
}

// Deprecated: Use buildProviderRegistry instead
export const PROVIDER_REGISTRY: Record<AgentProvider, ProviderDefinition> = null as any;

export function createAllClients(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, AgentClient> {
  const registry = buildProviderRegistry(logger, options);
  return Object.fromEntries(
    Object.entries(registry).map(([provider, definition]) => [
      provider,
      definition.createClient(logger),
    ]),
  ) as Record<AgentProvider, AgentClient>;
}

export async function shutdownProviders(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Promise<void> {
  await OpenCodeServerManager.getInstance(logger, options?.runtimeSettings?.opencode).shutdown();
}
