import type { Logger } from "pino";
import type { ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type { ProviderRegistration } from "@getpaseo/plugin/provider";

import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "../../agent-sdk-types.js";
import { normalizeAgentModelDefinition } from "../../agent-sdk-types.js";
import type {
  ProviderProfileModel,
  ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import type { WorkspaceGitService } from "../../../workspace-git-service.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import { ClaudeAgentClient } from "../claude/agent.js";
import { CodexAppServerAgentClient } from "../codex-app-server-agent.js";
import { CopilotACPAgentClient } from "../copilot-acp-agent.js";
import { CursorACPAgentClient } from "../cursor-acp-agent.js";
import { OpenCodeAgentClient } from "../opencode-agent.js";
import type { OpenCodeBridge } from "../opencode/bridge.js";
import { OmpAgentClient } from "../omp/agent.js";
import type { OmpRuntime } from "../omp/runtime.js";
import { PiRpcAgentClient } from "../pi/agent.js";
import { MockLoadTestAgentClient } from "../mock-load-test-agent.js";
import { MockSlowProviderClient } from "../mock-slow-provider.js";
import { ToolPolicyUnsupportedError } from "../../provider-options.js";
import { registerNativeProvider, relabelNativeClient } from "./provider.js";

interface NativeClientDependencies {
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  managedProcesses?: ManagedProcessRegistry;
  ompRuntime?: OmpRuntime;
  openCodeBridge?: OpenCodeBridge;
}

export interface NativeRegistrationSource {
  provider: AgentProvider;
  baseProvider: string;
  definition: AgentProviderDefinition;
  runtimeSettings?: ProviderRuntimeSettings;
  profileModels: ProviderProfileModel[];
  additionalModels: ProviderProfileModel[];
  profileModelsAreAdditive: boolean;
  providerParams?: unknown;
  customProvider?: { id: string; label: string; extends: string };
  dependencies: NativeClientDependencies;
}

export interface ClientRegistrationSource {
  logger: Logger;
  provider: AgentProvider;
  definition: AgentProviderDefinition;
  profileModels: ProviderProfileModel[];
  additionalModels: ProviderProfileModel[];
  profileModelsAreAdditive: boolean;
  createClient(): AgentClient;
  prepareToolPolicy?: (provider: string, toolPolicy: ToolPolicy) => ToolPolicy;
}

type NativeClientFactory = (
  logger: Logger,
  runtimeSettings: ProviderRuntimeSettings | undefined,
  source: NativeRegistrationSource,
) => AgentClient;

const NATIVE_CLIENT_FACTORIES: Record<string, NativeClientFactory> = {
  claude: (logger, runtimeSettings) => new ClaudeAgentClient({ logger, runtimeSettings }),
  codex: (logger, runtimeSettings, source) =>
    new CodexAppServerAgentClient(logger, runtimeSettings, {
      workspaceGitService: source.dependencies.workspaceGitService,
      customProvider: source.customProvider,
    }),
  copilot: (logger, runtimeSettings) => new CopilotACPAgentClient({ logger, runtimeSettings }),
  cursor: (logger, runtimeSettings) =>
    new CursorACPAgentClient({
      logger,
      command: resolveCursorCommand(runtimeSettings),
      env: runtimeSettings?.env,
    }),
  opencode: (logger, runtimeSettings, source) =>
    new OpenCodeAgentClient(logger, runtimeSettings, {
      managedProcesses: source.dependencies.managedProcesses,
      bridge: source.dependencies.openCodeBridge,
    }),
  pi: (logger, runtimeSettings, source) =>
    new PiRpcAgentClient({
      logger,
      runtimeSettings,
      providerParams: source.providerParams,
    }),
  omp: (logger, runtimeSettings, source) =>
    new OmpAgentClient({
      logger,
      runtimeSettings,
      providerParams: source.providerParams,
      runtime: source.dependencies.ompRuntime,
    }),
  mock: (logger) => new MockLoadTestAgentClient(logger),
  "mock-slow": () => new MockSlowProviderClient(),
};

const TOOL_POLICY_PROVIDERS = new Set(["claude", "codex", "opencode"]);

export function createNativeProviderRegistration(
  logger: Logger,
  source: NativeRegistrationSource,
): ProviderRegistration {
  const factory = NATIVE_CLIENT_FACTORIES[source.baseProvider];
  if (!factory) {
    throw new Error(`No provider client factory registered for '${source.baseProvider}'`);
  }
  return createClientProviderRegistration({
    logger,
    provider: source.provider,
    definition: source.definition,
    profileModels: source.profileModels,
    additionalModels: source.additionalModels,
    profileModelsAreAdditive: source.profileModelsAreAdditive,
    createClient: () => factory(logger, source.runtimeSettings, source),
    prepareToolPolicy: TOOL_POLICY_PROVIDERS.has(source.baseProvider) ? copyToolPolicy : undefined,
  });
}

export function createClientProviderRegistration(
  source: ClientRegistrationSource,
): ProviderRegistration {
  const modelClient = source.createClient();
  const profileModels = resolveConfiguredModels(source.provider, modelClient, source.profileModels);
  const additionalModels = resolveConfiguredModels(
    source.provider,
    modelClient,
    source.additionalModels,
  );
  const hasReplacementModels = profileModels.length > 0 && !source.profileModelsAreAdditive;
  const replacementModels = hasReplacementModels
    ? profileModels.map((model) => mapModel(source.provider, model))
    : [];
  const hasStaticModes = source.definition.modes.length > 0;

  const decorateModes = (modes: AgentMode[]): AgentMode[] =>
    modes.map((mode) => {
      if (mode.icon && mode.colorTier) return mode;
      const definitionMode = source.definition.modes.find((candidate) => candidate.id === mode.id);
      if (!definitionMode) return mode;
      return {
        ...mode,
        icon: mode.icon ?? definitionMode.icon,
        colorTier: mode.colorTier ?? definitionMode.colorTier,
      };
    });

  return registerNativeProvider({
    id: source.provider,
    label: source.definition.label,
    description: source.definition.description,
    createClient: () => createResolvedClient(source, profileModels, additionalModels),
    prepareToolPolicy: source.prepareToolPolicy
      ? (toolPolicy) => source.prepareToolPolicy!(source.provider, toolPolicy)
      : undefined,
    fetchCatalog: async (catalogClient, options) => {
      if (hasReplacementModels) {
        const models = mergeModelAdditions(source.provider, replacementModels, additionalModels);
        if (hasStaticModes) {
          const defaultModeId = await catalogClient.resolveDefaultModeId?.({
            config: {
              provider: source.provider,
              cwd: options.scope === "workspace" ? options.cwd : process.cwd(),
            },
          });
          return { models, modes: decorateModes(source.definition.modes), defaultModeId };
        }
        const catalog = await catalogClient.fetchCatalog(options);
        return { ...catalog, models, modes: decorateModes(catalog.modes) };
      }

      const catalog = await catalogClient.fetchCatalog(options);
      return {
        ...catalog,
        models: mergeModels(source.provider, profileModels, additionalModels, catalog.models, {
          profileModelsAreAdditive: source.profileModelsAreAdditive,
        }),
        modes: decorateModes(catalog.modes),
      };
    },
    transformConfig: (config) => {
      if (config.toolPolicy && !source.prepareToolPolicy) {
        throw new ToolPolicyUnsupportedError(source.provider);
      }
      return config;
    },
  });
}

function createResolvedClient(
  source: ClientRegistrationSource,
  profileModels: AgentModelDefinition[],
  additionalModels: AgentModelDefinition[],
): AgentClient {
  const inner = source.createClient();
  const hasModelOverrides = profileModels.length > 0 || additionalModels.length > 0;
  if (inner.provider === source.provider && !hasModelOverrides) return inner;
  return relabelNativeClient(source.provider, inner, (models) =>
    mergeModels(source.provider, profileModels, additionalModels, models, {
      profileModelsAreAdditive: source.profileModelsAreAdditive,
    }),
  );
}

function copyToolPolicy(_provider: string, toolPolicy: ToolPolicy): ToolPolicy {
  return { preapproved: toolPolicy.preapproved.map((grant) => ({ ...grant })) };
}

function resolveCursorCommand(
  runtimeSettings: ProviderRuntimeSettings | undefined,
): [string, ...string[]] {
  if (runtimeSettings?.command?.mode === "replace" && runtimeSettings.command.argv.length > 0) {
    return runtimeSettings.command.argv as [string, ...string[]];
  }
  return ["cursor-agent", "acp"];
}

function mapModel(
  provider: AgentProvider,
  model: AgentModelDefinition | ProviderProfileModel,
): AgentModelDefinition {
  return normalizeAgentModelDefinition({ ...model, provider });
}

function resolveConfiguredModels(
  provider: AgentProvider,
  client: AgentClient,
  models: ProviderProfileModel[],
): AgentModelDefinition[] {
  return models.map((model) => {
    const mapped = mapModel(provider, model);
    return client.resolveConfiguredModel?.(mapped) ?? mapped;
  });
}

function mergeModels(
  provider: AgentProvider,
  profileModels: AgentModelDefinition[],
  additionalModels: AgentModelDefinition[],
  runtimeModels: AgentModelDefinition[],
  options: { profileModelsAreAdditive: boolean },
): AgentModelDefinition[] {
  const baseModels = runtimeModels.map((model) => mapModel(provider, model));
  if (profileModels.length > 0 && !options.profileModelsAreAdditive) {
    return mergeModelAdditions(provider, profileModels, additionalModels);
  }
  return mergeModelAdditions(provider, baseModels, [...profileModels, ...additionalModels]);
}

function mergeModelAdditions(
  provider: AgentProvider,
  baseModels: AgentModelDefinition[],
  additions: Array<ProviderProfileModel | AgentModelDefinition>,
): AgentModelDefinition[] {
  if (additions.length === 0) return baseModels;
  const merged = [...baseModels];
  let hasAdditionalDefault = false;
  for (const model of additions) {
    const additional = mapModel(provider, model);
    hasAdditionalDefault ||= additional.isDefault === true;
    const index = merged.findIndex((candidate) => candidate.id === model.id);
    if (index === -1) {
      merged.push(additional);
      continue;
    }
    const existing = merged[index];
    const enablesCompatibilityModel =
      existing?.isSelectable === false && additional.isSelectable === undefined;
    merged[index] = {
      ...existing,
      ...additional,
      ...(enablesCompatibilityModel ? { isSelectable: true } : {}),
    };
  }
  if (!hasAdditionalDefault) return merged;
  const defaultIds = new Set(
    additions.filter((model) => model.isDefault === true).map((model) => model.id),
  );
  return merged.map((model) =>
    defaultIds.has(model.id) ? model : Object.assign({}, model, { isDefault: false }),
  );
}
