import type { Logger } from "pino";
import type { ProviderRegistration } from "@getpaseo/plugin/provider";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
  ProviderRuntimeSettings,
} from "./provider-launch-config.js";
import type { OpenCodeBridge } from "./providers/opencode/bridge.js";
import type { OmpRuntime } from "./providers/omp/runtime.js";
import {
  createNativeProviderRegistration,
  type NativeRegistrationSource,
} from "./providers/native/registration-factory.js";
import { createAcpProviderRegistration } from "./providers/acp-registration-factory.js";
import { ProviderRuntime } from "./provider-connection-runtime.js";
import {
  AGENT_PROVIDER_DEFINITIONS,
  BUILTIN_PROVIDER_IDS,
  DEV_AGENT_PROVIDER_DEFINITIONS,
  getAgentProviderDefinition,
  type AgentProviderDefinition,
} from "@getpaseo/protocol/provider-manifest";

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
  registration: ProviderRegistration;
}

export interface BuildProviderRegistryOptions {
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
  providerOverrides?: Record<string, ProviderOverride>;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  isDev?: boolean;
  ompRuntime?: OmpRuntime;
  openCodeBridge?: OpenCodeBridge;
  providerRegistrations?: readonly ProviderRegistration[];
}

interface ResolvedProvider {
  definition: AgentProviderDefinition;
  runtimeSettings?: ProviderRuntimeSettings;
  enabled: boolean;
  derivedFromProviderId: string | null;
  providerParams?: unknown;
  nativeSource?: NativeRegistrationSource;
  registration: ProviderRegistration;
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

function createRegistryEntry(resolved: ResolvedProvider): ProviderDefinition {
  return {
    ...resolved.definition,
    enabled: resolved.enabled,
    derivedFromProviderId: resolved.derivedFromProviderId,
    registration: resolved.registration,
  };
}

function buildResolvedBuiltinProviders(
  logger: Logger,
  providerOverrides: Record<string, ProviderOverride>,
  runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
  options: Pick<
    BuildProviderRegistryOptions,
    "workspaceGitService" | "managedProcesses" | "ompRuntime" | "openCodeBridge"
  >,
  isDev: boolean,
): Map<string, ResolvedProvider> {
  const resolvedProviders = new Map<string, ResolvedProvider>();

  const definitions = isDev
    ? [...AGENT_PROVIDER_DEFINITIONS, ...DEV_AGENT_PROVIDER_DEFINITIONS]
    : AGENT_PROVIDER_DEFINITIONS;

  for (const definition of definitions) {
    const override = providerOverrides[definition.id];
    const mergedRuntimeSettings = mergeRuntimeSettings(
      runtimeSettings?.[definition.id],
      toRuntimeSettings(override),
    );
    const resolvedDefinition = applyOverrideToDefinition(definition, override);
    const nativeSource: NativeRegistrationSource = {
      provider: definition.id,
      baseProvider: definition.id,
      definition: resolvedDefinition,
      runtimeSettings: mergedRuntimeSettings,
      profileModels: override?.models ?? [],
      additionalModels: override?.additionalModels ?? [],
      profileModelsAreAdditive: false,
      providerParams: override?.params,
      dependencies: {
        workspaceGitService: options.workspaceGitService,
        managedProcesses: options.managedProcesses,
        ompRuntime: options.ompRuntime,
        openCodeBridge: options.openCodeBridge,
      },
    };
    resolvedProviders.set(definition.id, {
      definition: resolvedDefinition,
      runtimeSettings: mergedRuntimeSettings,
      enabled: override?.enabled ?? definition.enabledByDefault ?? true,
      derivedFromProviderId: null,
      providerParams: override?.params,
      nativeSource,
      registration: createNativeProviderRegistration(logger, nativeSource),
    });
  }

  return resolvedProviders;
}

function addDerivedProviders(
  logger: Logger,
  resolvedProviders: Map<string, ResolvedProvider>,
  providerOverrides: Record<string, ProviderOverride>,
  options: Pick<BuildProviderRegistryOptions, "managedProcesses" | "openCodeBridge">,
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
      const command = override.command;
      const definition = createDerivedDefinition(
        providerId,
        {
          id: providerId,
          label: override.label ?? providerId,
          description: override.description ?? "Custom ACP provider",
          defaultModeId: null,
          modes: [],
        },
        override,
      );
      resolvedProviders.set(providerId, {
        definition,
        runtimeSettings: toRuntimeSettings(override),
        enabled: override.enabled !== false,
        derivedFromProviderId: null,
        providerParams: override.params,
        registration: createAcpProviderRegistration(logger, {
          provider: providerId,
          definition,
          command,
          env: override.env,
          providerParams: override.params,
          profileModels: override.models ?? [],
          additionalModels: override.additionalModels ?? [],
        }),
      });
      continue;
    }

    const baseProviderId = override.extends;
    const baseProvider = resolvedProviders.get(baseProviderId);
    if (!baseProvider) {
      throw new Error(
        `Custom provider '${providerId}' extends unknown provider '${baseProviderId}'`,
      );
    }

    const mergedRuntimeSettings = mergeRuntimeSettings(
      baseProvider.runtimeSettings,
      toRuntimeSettings(override),
    );
    const baseDefinition = baseProvider.definition;
    const baseNativeSource = baseProvider.nativeSource;
    if (!baseNativeSource) {
      throw new Error(`Custom provider '${providerId}' cannot extend '${baseProviderId}'`);
    }
    const providerParams = override.params ?? baseProvider.providerParams;
    const definition = createDerivedDefinition(providerId, baseDefinition, override);
    const nativeSource: NativeRegistrationSource = {
      provider: providerId,
      baseProvider: baseNativeSource.baseProvider,
      definition,
      runtimeSettings: mergedRuntimeSettings,
      profileModels: override.models ?? [],
      additionalModels: override.additionalModels ?? [],
      profileModelsAreAdditive: false,
      providerParams,
      customProvider: {
        id: providerId,
        label: override.label ?? providerId,
        extends: baseProviderId,
      },
      dependencies: {
        managedProcesses: options.managedProcesses,
        openCodeBridge: options.openCodeBridge,
      },
    };
    resolvedProviders.set(providerId, {
      definition,
      runtimeSettings: mergedRuntimeSettings,
      enabled: override.enabled !== false,
      derivedFromProviderId: baseProviderId,
      providerParams,
      nativeSource,
      registration: createNativeProviderRegistration(logger, nativeSource),
    });
  }
}

function addPluginProviders(
  resolvedProviders: Map<string, ResolvedProvider>,
  registrations: readonly ProviderRegistration[],
): void {
  for (const registration of registrations) {
    if (resolvedProviders.has(registration.id) || BUILTIN_PROVIDER_IDS.includes(registration.id)) {
      throw new Error(`Plugin provider ID '${registration.id}' is already registered`);
    }
    resolvedProviders.set(registration.id, {
      definition: {
        id: registration.id,
        label: registration.label,
        description: registration.description ?? "Plugin provider",
        defaultModeId: null,
        modes: [],
      },
      enabled: true,
      derivedFromProviderId: null,
      registration,
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
    logger,
    providerOverrides,
    runtimeSettings,
    {
      workspaceGitService: options?.workspaceGitService,
      managedProcesses: options?.managedProcesses,
      ompRuntime: options?.ompRuntime,
      openCodeBridge: options?.openCodeBridge,
    },
    options?.isDev === true,
  );
  addDerivedProviders(logger, resolvedProviders, providerOverrides, {
    managedProcesses: options?.managedProcesses,
    openCodeBridge: options?.openCodeBridge,
  });
  addPluginProviders(resolvedProviders, options?.providerRegistrations ?? []);

  return Object.fromEntries(
    [...resolvedProviders.entries()].map(([provider, resolved]) => [
      provider,
      createRegistryEntry(resolved),
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

export async function shutdownProviders(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Promise<void> {
  const runtimes = Object.values(buildProviderRegistry(logger, options)).map(
    (definition) => new ProviderRuntime(definition.registration),
  );
  await Promise.all(runtimes.map((runtime) => runtime.close()));
}
