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
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
  ProviderProfileModel,
  ProviderRuntimeSettings,
} from "./provider-launch-config.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { CopilotACPAgentClient } from "./providers/copilot-acp-agent.js";
import { GenericACPAgentClient } from "./providers/generic-acp-agent.js";
import { OpenCodeAgentClient, OpenCodeServerManager } from "./providers/opencode-agent.js";
import { PiDirectAgentClient } from "./providers/pi-direct-agent.js";
import { MockLoadTestAgentClient } from "./providers/mock-load-test-agent.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
  getAgentProviderDefinition,
  type AgentProviderDefinition,
} from "./provider-manifest.js";

function isNonEmptyStringArray(value: string[]): value is [string, ...string[]] {
  return value.length > 0;
}

export type { AgentProviderDefinition };

export { AGENT_PROVIDER_DEFINITIONS, getAgentProviderDefinition };

export interface ProviderDefinition extends AgentProviderDefinition {
  enabled: boolean;
  /**
   * The id of another *registered* provider this one extends (e.g. a Z.AI
   * profile that extends "claude"). null for built-in providers and for
   * generic ACP providers (which only extend the literal "acp" sentinel).
   */
  derivedFromProviderId: string | null;
  createClient: (logger: Logger) => AgentClient;
  fetchModels: (options: ListModelsOptions) => Promise<AgentModelDefinition[]>;
  fetchModes: (options: ListModesOptions) => Promise<AgentMode[]>;
}

export { IMPORTABLE_PROVIDERS } from "../../shared/importable-providers.js";

export interface BuildProviderRegistryOptions {
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  isDev?: boolean;
}

type ProviderClientFactory = (
  logger: Logger,
  runtimeSettings?: ProviderRuntimeSettings,
  options?: Pick<BuildProviderRegistryOptions, "workspaceGitService">,
) => AgentClient;

interface ResolvedProvider {
  definition: AgentProviderDefinition;
  runtimeSettings?: ProviderRuntimeSettings;
  profileModels: ProviderProfileModel[];
  additionalModels: ProviderProfileModel[];
  enabled: boolean;
  derivedFromProviderId: string | null;
  createBaseClient: (logger: Logger) => AgentClient;
}

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  claude: (logger, runtimeSettings) =>
    new ClaudeAgentClient({
      logger,
      runtimeSettings,
    }),
  codex: (logger, runtimeSettings, options) =>
    new CodexAppServerAgentClient(logger, runtimeSettings, {
      workspaceGitService: options?.workspaceGitService,
    }),
  copilot: (logger, runtimeSettings) =>
    new CopilotACPAgentClient({
      logger,
      runtimeSettings,
    }),
  opencode: (logger, runtimeSettings) => new OpenCodeAgentClient(logger, runtimeSettings),
  pi: (logger, runtimeSettings) =>
    new PiDirectAgentClient({
      logger,
      runtimeSettings,
    }),
  mock: (logger) => new MockLoadTestAgentClient(logger),
};

function getProviderClientFactory(provider: string): ProviderClientFactory {
  const factory = PROVIDER_CLIENT_FACTORIES[provider];
  if (!factory) {
    throw new Error(`No provider client factory registered for '${provider}'`);
  }
  return factory;
}

function toRuntimeSettings(override?: ProviderOverride): ProviderRuntimeSettings | undefined {
  if (!override?.command && !override?.env && !override?.disallowedTools) {
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
    disallowedTools: override.disallowedTools,
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
            ...base?.env,
            ...override?.env,
          }
        : undefined,
    disallowedTools:
      base?.disallowedTools || override?.disallowedTools
        ? [...(base?.disallowedTools ?? []), ...(override?.disallowedTools ?? [])]
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
  additionalModels: ProviderProfileModel[],
  runtimeModels: AgentModelDefinition[],
): AgentModelDefinition[] {
  const baseModels =
    profileModels.length === 0
      ? runtimeModels.map((model) => mapModel(provider, model))
      : profileModels.map((model) => ({
          ...model,
          provider,
        }));

  if (additionalModels.length === 0) {
    return baseModels;
  }

  const mergedModels = [...baseModels];
  let hasAdditionalDefault = false;

  for (const model of additionalModels) {
    const additionalModel = {
      ...model,
      provider,
    };
    hasAdditionalDefault ||= additionalModel.isDefault === true;

    const existingIndex = mergedModels.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex === -1) {
      mergedModels.push(additionalModel);
      continue;
    }

    mergedModels[existingIndex] = {
      ...mergedModels[existingIndex],
      ...additionalModel,
    };
  }

  if (!hasAdditionalDefault) {
    return mergedModels;
  }

  const additionalDefaultIds = new Set(
    additionalModels.filter((model) => model.isDefault === true).map((model) => model.id),
  );

  return mergedModels.map((model) =>
    additionalDefaultIds.has(model.id) ? model : Object.assign({}, model, { isDefault: false }),
  );
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

function wrapClientProvider(
  provider: AgentProvider,
  inner: AgentClient,
  profileModels: ProviderProfileModel[],
  additionalModels: ProviderProfileModel[],
): AgentClient {
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
      mergeModels(provider, profileModels, additionalModels, await inner.listModels(options)),
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
    enabled: resolved.enabled,
    derivedFromProviderId: resolved.derivedFromProviderId,
    createClient: (providerLogger: Logger) =>
      createResolvedProviderClient(providerLogger, provider, resolved),
    fetchModels: async (options: ListModelsOptions) =>
      mergeModels(
        provider,
        resolved.profileModels,
        resolved.additionalModels,
        await modelClient.listModels(options),
      ),
    fetchModes: async (options: ListModesOptions) => {
      const modes = modelClient.listModes
        ? await modelClient.listModes(options)
        : resolved.definition.modes;
      return modes.map((mode) => {
        if (mode.icon && mode.colorTier) return mode;
        const definitionMode = resolved.definition.modes.find((d) => d.id === mode.id);
        if (!definitionMode) return mode;
        return Object.assign({}, mode, {
          icon: mode.icon ?? definitionMode.icon,
          colorTier: mode.colorTier ?? definitionMode.colorTier,
        });
      });
    },
  };
}

function createResolvedProviderClient(
  logger: Logger,
  provider: AgentProvider,
  resolved: ResolvedProvider,
): AgentClient {
  const inner = resolved.createBaseClient(logger);
  const hasModelOverrides =
    resolved.profileModels.length > 0 || resolved.additionalModels.length > 0;
  if (inner.provider === provider && !hasModelOverrides) {
    return inner;
  }
  return wrapClientProvider(provider, inner, resolved.profileModels, resolved.additionalModels);
}

function buildResolvedBuiltinProviders(
  providerOverrides: Record<string, ProviderOverride>,
  runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
  options: Pick<BuildProviderRegistryOptions, "workspaceGitService">,
  isDev: boolean,
): Map<string, ResolvedProvider> {
  const resolvedProviders = new Map<string, ResolvedProvider>();

  const definitions = isDev
    ? [...AGENT_PROVIDER_DEFINITIONS, ...DEV_AGENT_PROVIDER_DEFINITIONS]
    : AGENT_PROVIDER_DEFINITIONS;

  for (const definition of definitions) {
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
      additionalModels: override?.additionalModels ?? [],
      enabled: override?.enabled !== false,
      derivedFromProviderId: null,
      createBaseClient: (logger) =>
        factory(logger, mergedRuntimeSettings, {
          workspaceGitService: options.workspaceGitService,
        }),
    });
  }

  return resolvedProviders;
}

function addDerivedProviders(
  resolvedProviders: Map<string, ResolvedProvider>,
  providerOverrides: Record<string, ProviderOverride>,
): void {
  for (const [providerId, override] of Object.entries(providerOverrides)) {
    if (resolvedProviders.has(providerId) || BUILTIN_PROVIDER_IDS.includes(providerId)) {
      continue;
    }

    if (!override.extends) {
      throw new Error(`Custom provider '${providerId}' requires an extends value`);
    }

    if (override.extends === "acp") {
      if (!override.command || !isNonEmptyStringArray(override.command)) {
        throw new Error(`ACP provider '${providerId}' requires a command`);
      }
      // Capture command in const for closure - TypeScript can't track type refinement inside closures
      const command = override.command;

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
        additionalModels: override.additionalModels ?? [],
        enabled: override.enabled !== false,
        derivedFromProviderId: null,
        createBaseClient: (logger) =>
          new GenericACPAgentClient({
            logger,
            command,
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
      additionalModels: override.additionalModels ?? [],
      enabled: override.enabled !== false,
      derivedFromProviderId: override.extends,
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
  const resolvedProviders = buildResolvedBuiltinProviders(
    providerOverrides,
    runtimeSettings,
    {
      workspaceGitService: options?.workspaceGitService,
    },
    options?.isDev === true,
  );
  addDerivedProviders(resolvedProviders, providerOverrides);

  return Object.fromEntries(
    [...resolvedProviders.entries()].map(([provider, resolved]) => [
      provider,
      createRegistryEntry(logger, provider, resolved),
    ]),
  ) as Record<AgentProvider, ProviderDefinition>;
}

export function getProviderIds(
  registry: Record<AgentProvider, ProviderDefinition>,
): AgentProvider[] {
  return Object.keys(registry);
}

// Deprecated: Use buildProviderRegistry instead
export const PROVIDER_REGISTRY: Record<AgentProvider, ProviderDefinition> =
  null as unknown as Record<AgentProvider, ProviderDefinition>;

export function createAllClients(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, AgentClient> {
  return createClientsFromRegistry(buildProviderRegistry(logger, options), logger);
}

export function createClientsFromRegistry(
  registry: Record<AgentProvider, ProviderDefinition>,
  logger: Logger,
): Record<AgentProvider, AgentClient> {
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
