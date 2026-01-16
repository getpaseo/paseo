import type {
  AgentClient,
  AgentModelDefinition,
  AgentProvider,
  ListModelsOptions,
} from "./agent-sdk-types.js";
import type { Logger } from "pino";

import { ClaudeAgentClient } from "./providers/claude-agent.js";
import { CodexMcpAgentClient } from "./providers/codex-mcp-agent.js";
import { OpenCodeAgentClient, OpenCodeServerManager } from "./providers/opencode-agent.js";

import {
  AGENT_PROVIDER_DEFINITIONS,
  getAgentProviderDefinition,
  type AgentProviderDefinition,
} from "./provider-manifest.js";

export type {
  AgentProviderDefinition,
};

export {
  AGENT_PROVIDER_DEFINITIONS,
  getAgentProviderDefinition,
};

export interface ProviderDefinition extends AgentProviderDefinition {
  createClient: (logger: Logger) => AgentClient;
  fetchModels: (options?: ListModelsOptions) => Promise<AgentModelDefinition[]>;
}

export function buildProviderRegistry(logger: Logger): Record<AgentProvider, ProviderDefinition> {
  const claudeClient = new ClaudeAgentClient({ logger });
  const codexClient = new CodexMcpAgentClient(logger);
  const opencodeClient = new OpenCodeAgentClient(logger);

  return {
    claude: {
      ...AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "claude")!,
      createClient: (logger: Logger) => new ClaudeAgentClient({ logger }),
      fetchModels: (options) => claudeClient.listModels(options),
    },
    codex: {
      ...AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "codex")!,
      createClient: (logger: Logger) => new CodexMcpAgentClient(logger),
      fetchModels: (options) => codexClient.listModels(options),
    },
    opencode: {
      ...AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "opencode")!,
      createClient: (logger: Logger) => new OpenCodeAgentClient(logger),
      fetchModels: (options) => opencodeClient.listModels(options),
    },
  };
}

// Deprecated: Use buildProviderRegistry instead
export const PROVIDER_REGISTRY: Record<AgentProvider, ProviderDefinition> = null as any;

export function createAllClients(logger: Logger): Record<AgentProvider, AgentClient> {
  const registry = buildProviderRegistry(logger);
  return {
    claude: registry.claude.createClient(logger),
    codex: registry.codex.createClient(logger),
    opencode: registry.opencode.createClient(logger),
  };
}

export async function shutdownProviders(logger: Logger): Promise<void> {
  await OpenCodeServerManager.getInstance(logger).shutdown();
}
