/**
 * Shared agent configurations for e2e tests.
 * Enables running the same tests against both Claude and Codex providers.
 */

export interface AgentTestConfig {
  provider: "claude" | "codex";
  model: string;
  thinkingOptionId?: string;
  modes: {
    full: string; // No permissions required
    ask: string; // Requires permission approval
  };
}

export const agentConfigs = {
  claude: {
    provider: "claude",
    model: "haiku",
    modes: {
      full: "bypassPermissions",
      ask: "default",
    },
  },
  codex: {
    provider: "codex",
    model: "gpt-5.1-codex-mini",
    thinkingOptionId: "low",
    modes: {
      full: "full-access",
      ask: "auto",
    },
  },
} as const satisfies Record<string, AgentTestConfig>;

export type AgentProvider = keyof typeof agentConfigs;

/**
 * Get test config for creating an agent with full permissions (no prompts).
 */
export function getFullAccessConfig(provider: AgentProvider) {
  const config = agentConfigs[provider];
  const thinkingOptionId = "thinkingOptionId" in config ? config.thinkingOptionId : undefined;
  return {
    provider: config.provider,
    model: config.model,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    modeId: config.modes.full,
  };
}

/**
 * Get test config for creating an agent that requires permission approval.
 */
export function getAskModeConfig(provider: AgentProvider) {
  const config = agentConfigs[provider];
  const thinkingOptionId = "thinkingOptionId" in config ? config.thinkingOptionId : undefined;
  return {
    provider: config.provider,
    model: config.model,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    modeId: config.modes.ask,
  };
}

/**
 * Helper to run a test for each provider.
 */
export const allProviders: AgentProvider[] = ["claude", "codex"];
