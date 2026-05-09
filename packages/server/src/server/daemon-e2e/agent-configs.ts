/**
 * Shared agent configurations for e2e tests.
 * Enables running the same tests against Claude, Codex, and OpenCode providers.
 */
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import dotenv from "dotenv";
import { isCommandAvailable } from "../../utils/executable.js";

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
      full: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
      ask: "https://agentclientprotocol.com/protocol/session-modes#agent",
    },
  },
  opencode: {
    provider: "opencode",
    model: "opencode/glm-5-free",
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
const providerAvailabilityCache = new Map<AgentProvider, Promise<boolean>>();

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
 * Whether a real provider can run in this environment.
 * Checks binary availability AND credentials (env vars, OAuth tokens, auth files).
 *
 * Credentials are typically loaded from .env.test via the vitest setup file.
 * This MUST be a function (not a const) so process.env is read at call time,
 * after dotenv has injected the test credentials.
 */
export function isProviderAvailable(provider: AgentProvider): Promise<boolean> {
  const cached = providerAvailabilityCache.get(provider);
  if (cached) {
    return cached;
  }

  const availability = (async (): Promise<boolean> => {
    switch (provider) {
      case "claude":
        const hasClaudeEnvCredentials =
          Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) || Boolean(process.env.ANTHROPIC_API_KEY);
        return (await isCommandAvailable("claude")) && (!process.env.CI || hasClaudeEnvCredentials);
      case "codex":
        return (
          (await isCommandAvailable("codex")) &&
          (existsSync(join(homedir(), ".codex", "auth.json")) ||
            Boolean(process.env.OPENAI_API_KEY))
        );
      case "copilot":
        return await isCommandAvailable("copilot");
      case "opencode":
        return await isCommandAvailable("opencode");
      case "pi":
        return (
          (await isCommandAvailable(
            process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi",
          )) &&
          (Boolean(process.env.OPENAI_API_KEY) ||
            Boolean(process.env.ANTHROPIC_API_KEY) ||
            Boolean(process.env.OPENROUTER_API_KEY) ||
            existsSync(join(homedir(), ".pi", "agent", "auth.json")))
        );
      default:
        return false;
    }
  })();

  providerAvailabilityCache.set(provider, availability);
  return availability;
}

/**
 * Helper to run a test for each provider.
 */
export const allProviders: AgentProvider[] = ["claude", "codex", "copilot", "opencode", "pi"];
