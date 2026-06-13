import {
  type AgentHookActivityInput,
  type AgentHookActivityState,
  type AgentHookInstallLogger,
  type AgentHookInstallOptions,
  type AgentHookInstallResult,
  type AgentHookProvider,
  agentHooksAreInstalled,
  installAgentHooks,
  uninstallAgentHooks,
} from "./agent-hook-installer.js";
import { claudeAgentHookProvider } from "./claude/claude.js";
import { codexAgentHookProvider } from "./codex/codex.js";
import { opencodeAgentHookProvider } from "./opencode/opencode.js";

export type {
  AgentHookActivityInput,
  AgentHookActivityState,
  AgentHookProvider,
} from "./agent-hook-installer.js";

export const AGENT_HOOK_PROVIDERS = {
  [claudeAgentHookProvider.id]: claudeAgentHookProvider,
  [codexAgentHookProvider.id]: codexAgentHookProvider,
  [opencodeAgentHookProvider.id]: opencodeAgentHookProvider,
} satisfies Record<string, AgentHookProvider>;

export type AgentHookProviderId = keyof typeof AGENT_HOOK_PROVIDERS;

export interface AgentHookActivityRequest {
  provider: string;
  event: string;
  input: AgentHookActivityInput;
}

export interface RegisteredAgentHookInstallOptions extends AgentHookInstallOptions {
  logger?: AgentHookInstallLogger;
}

export function installRegisteredAgentHooks(
  options: RegisteredAgentHookInstallOptions = {},
): AgentHookInstallResult[] {
  const results: AgentHookInstallResult[] = [];
  for (const provider of Object.values(AGENT_HOOK_PROVIDERS)) {
    try {
      results.push(installAgentHooks(provider, options));
    } catch (error) {
      options.logger?.warn(
        { err: error, provider: provider.id },
        "Failed to install terminal activity hook provider",
      );
    }
  }
  return results;
}

export function uninstallRegisteredAgentHooks(options: AgentHookInstallOptions = {}): void {
  for (const provider of Object.values(AGENT_HOOK_PROVIDERS)) {
    uninstallAgentHooks(provider, options);
  }
}

export function registeredAgentHooksAreInstalled(options: AgentHookInstallOptions = {}): boolean {
  return Object.values(AGENT_HOOK_PROVIDERS).every((provider) =>
    agentHooksAreInstalled(provider, options),
  );
}

export async function resolveHookActivity(
  request: AgentHookActivityRequest,
): Promise<AgentHookActivityState | null> {
  const provider = AGENT_HOOK_PROVIDERS[request.provider.toLowerCase()];
  if (!provider) return null;

  return provider.resolveActivity({ event: request.event, input: request.input });
}
