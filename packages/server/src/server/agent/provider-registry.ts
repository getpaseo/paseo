import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ListModelsOptions,
  ListModesOptions,
} from "./agent-sdk-types.js";
import type { AgentProviderRuntimeSettingsMap } from "./provider-launch-config.js";
import type { Logger } from "pino";

import { ClaudeAgentClient } from "./providers/claude-agent.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { OpenCodeAgentClient, OpenCodeServerManager } from "./providers/opencode-agent.js";
import { CopilotACPAgentClient } from "./providers/copilot-acp-agent.js";
import { PiACPAgentClient } from "./providers/pi-acp-agent.js";

import {
  AGENT_PROVIDER_DEFINITIONS,
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

type BuildProviderRegistryOptions = {
  runtimeSettings?: AgentProviderRuntimeSettingsMap;
};

type ProviderClientFactory = (
  logger: Logger,
  runtimeSettings?: AgentProviderRuntimeSettingsMap,
) => AgentClient;

const PROVIDER_CLIENT_FACTORIES: Record<string, ProviderClientFactory> = {
  claude: (logger, runtimeSettings) =>
    new ClaudeAgentClient({
      logger,
      runtimeSettings: runtimeSettings?.claude,
    }),
  codex: (logger, runtimeSettings) => new CodexAppServerAgentClient(logger, runtimeSettings?.codex),
  copilot: (logger, runtimeSettings) =>
    new CopilotACPAgentClient({
      logger,
      runtimeSettings: runtimeSettings?.copilot,
    }),
  opencode: (logger, runtimeSettings) =>
    new OpenCodeAgentClient(logger, runtimeSettings?.opencode),
  pi: (logger, runtimeSettings) => new PiACPAgentClient({ logger, runtimeSettings: runtimeSettings?.pi }),
};

function getProviderClientFactory(provider: string): ProviderClientFactory {
  const factory = PROVIDER_CLIENT_FACTORIES[provider];
  if (!factory) {
    throw new Error(`No provider client factory registered for '${provider}'`);
  }
  return factory;
}

export function buildProviderRegistry(
  logger: Logger,
  options?: BuildProviderRegistryOptions,
): Record<AgentProvider, ProviderDefinition> {
  const runtimeSettings = options?.runtimeSettings;
  return Object.fromEntries(
    AGENT_PROVIDER_DEFINITIONS.map((definition) => {
      const createClient = getProviderClientFactory(definition.id);
      const modelClient = createClient(logger, runtimeSettings);
      return [
        definition.id,
        {
          ...definition,
          createClient: (providerLogger: Logger) => createClient(providerLogger, runtimeSettings),
          fetchModels: (listOptions?: ListModelsOptions) => modelClient.listModels(listOptions),
          fetchModes: (listOptions?: ListModesOptions) =>
            modelClient.listModes
              ? modelClient.listModes(listOptions)
              : Promise.resolve(definition.modes),
        } satisfies ProviderDefinition,
      ];
    }),
  ) as Record<AgentProvider, ProviderDefinition>;
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
