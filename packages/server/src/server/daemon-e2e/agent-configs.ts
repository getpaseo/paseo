/**
 * Shared agent configurations for e2e tests.
 * Enables running the same tests against Claude, Codex, and OpenCode providers.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: resolve(serverRoot, ".env.test"), override: true });

export interface AgentTestConfig {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  modes?: {
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
    model: "gpt-5.4-mini",
    thinkingOptionId: "low",
    modes: {
      full: "full-access",
      ask: "auto",
    },
  },
  copilot: {
    provider: "copilot",
    model: "claude-haiku-4.5",
    modes: {
      full: "allow-all",
      ask: "https://agentclientprotocol.com/protocol/session-modes#agent",
    },
  },
  opencode: {
    provider: "opencode",
    model: "opencode/big-pickle",
    modes: {
      full: "default",
      ask: "default",
    },
  },
  pi: {
    provider: "pi",
    thinkingOptionId: "medium",
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
    ...(config.model ? { model: config.model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(config.modes?.full ? { modeId: config.modes.full } : {}),
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
    ...(config.model ? { model: config.model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(config.modes?.ask ? { modeId: config.modes.ask } : {}),
  };
}

/**
 * Helper to run a test for each provider.
 */
export const allProviders: AgentProvider[] = ["claude", "codex", "opencode", "pi"];
