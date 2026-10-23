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

export interface AgentHookReport {
  state: AgentHookActivityState;
  // Present when the event identifies the agent session; `sessionId: null` means it ended.
  agentSession?: { provider: string; sessionId: string | null; cwd?: string };
}

export async function resolveHookReport(
  request: AgentHookActivityRequest,
): Promise<AgentHookReport | null> {
  const providerId = request.provider.toLowerCase();
  const provider: AgentHookProvider | undefined = AGENT_HOOK_PROVIDERS[providerId];
  if (!provider) return null;

  // Stdin can only be consumed once; activity and session resolution share it.
  let pendingRead: Promise<string | null> | null = null;
  const input: AgentHookActivityInput = {
    isTTY: request.input.isTTY,
    read: () => {
      pendingRead ??= request.input.read();
      return pendingRead;
    },
  };

  const state = await provider.resolveActivity({ event: request.event, input });
  if (!state) return null;

  const session = await provider.resolveSession?.({ event: request.event, input });
  if (session === undefined) return { state };
  const agentSession = session ?? { sessionId: null };
  return { state, agentSession: { provider: providerId, ...agentSession } };
}
