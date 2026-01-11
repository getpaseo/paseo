import type {
  AgentClient,
  AgentModelDefinition,
  AgentProvider,
  ListModelsOptions,
} from "./agent-sdk-types.js";

import { ClaudeAgentClient } from "./providers/claude-agent.js";
import { CodexMcpAgentClient } from "./providers/codex-mcp-agent.js";
import { OpenCodeAgentClient } from "./providers/opencode-agent.js";

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
  createClient: () => AgentClient;
  fetchModels: (options?: ListModelsOptions) => Promise<AgentModelDefinition[]>;
}

const claudeClient = new ClaudeAgentClient();
const codexClient = new CodexMcpAgentClient();
const opencodeClient = new OpenCodeAgentClient();

export const PROVIDER_REGISTRY: Record<AgentProvider, ProviderDefinition> = {
  claude: {
    ...AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "claude")!,
    createClient: () => new ClaudeAgentClient(),
    fetchModels: (options) => claudeClient.listModels(options),
  },
  codex: {
    ...AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "codex")!,
    createClient: () => new CodexMcpAgentClient(),
    fetchModels: (options) => codexClient.listModels(options),
  },
  opencode: {
    ...AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === "opencode")!,
    createClient: () => new OpenCodeAgentClient(),
    fetchModels: (options) => opencodeClient.listModels(options),
  },
};

export function getProviderDefinition(provider: AgentProvider): ProviderDefinition {
  const definition = PROVIDER_REGISTRY[provider];
  if (!definition) {
    throw new Error(`Unknown agent provider: ${provider}`);
  }
  return definition;
}

export function getAllProviderDefinitions(): ProviderDefinition[] {
  return Object.values(PROVIDER_REGISTRY);
}

export function createAllClients(): Record<AgentProvider, AgentClient> {
  const clients: Partial<Record<AgentProvider, AgentClient>> = {};
  for (const [id, definition] of Object.entries(PROVIDER_REGISTRY)) {
    clients[id as AgentProvider] = definition.createClient();
  }
  return clients as Record<AgentProvider, AgentClient>;
}

export async function fetchProviderModels(
  provider: AgentProvider,
  options?: { cwd?: string }
): Promise<AgentModelDefinition[]> {
  const definition = getProviderDefinition(provider);
  return definition.fetchModels(options);
}
