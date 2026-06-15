import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Logger } from "pino";

import type { AgentClient, AgentProvider, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";

export const realProviders = ["claude", "codex", "opencode", "pi"] as const;
export type RealProvider = (typeof realProviders)[number];
export type RealProviderConfig = Pick<
  AgentSessionConfig,
  "provider" | "model" | "modeId" | "thinkingOptionId"
>;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const OPENROUTER_OPENAI_BASE_URL = "https://openrouter.ai/api";
const CLAUDE_REAL_TEST_MODEL = "haiku";
const CODEX_REAL_TEST_MODEL = "~openai/gpt-latest";
const OPENCODE_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";
const PI_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";

const availabilityCache = new Map<RealProvider, Promise<boolean>>();

export function getRealProviderConfig(provider: RealProvider): RealProviderConfig {
  switch (provider) {
    case "claude":
      return {
        provider,
        model: CLAUDE_REAL_TEST_MODEL,
        modeId: "bypassPermissions",
      };
    case "codex":
      return {
        provider,
        model: CODEX_REAL_TEST_MODEL,
        thinkingOptionId: "low",
        modeId: "full-access",
      };
    case "opencode":
      return {
        provider,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "build",
      };
    case "pi":
      return {
        provider,
        model: PI_REAL_TEST_MODEL,
        thinkingOptionId: "medium",
      };
  }
}

export function getRealProviderRuntimeSettings(provider: RealProvider): ProviderRuntimeSettings {
  const apiKey = getOpenRouterApiKey();
  switch (provider) {
    case "claude":
      return {
        env: {
          OPENROUTER_API_KEY: apiKey,
          ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "~anthropic/claude-haiku-latest",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "~anthropic/claude-sonnet-latest",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "~anthropic/claude-opus-latest",
          CLAUDE_CODE_SUBAGENT_MODEL: "~anthropic/claude-haiku-latest",
        },
      };
    case "codex":
      return {
        env: {
          OPENROUTER_API_KEY: apiKey,
          OPENAI_API_KEY: apiKey,
          OPENAI_BASE_URL: OPENROUTER_OPENAI_BASE_URL,
        },
      };
    case "opencode": {
      const root = mkdtempSync(path.join(tmpdir(), "paseo-real-opencode-"));
      return {
        env: {
          OPENROUTER_API_KEY: apiKey,
          OPENCODE_DISABLE_AUTO_UPDATE: "1",
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
      };
    }
    case "pi":
      return {
        env: {
          OPENROUTER_API_KEY: apiKey,
        },
      };
  }
}

export function createRealProviderClient(provider: RealProvider, logger: Logger): AgentClient {
  const runtimeSettings = getRealProviderRuntimeSettings(provider);
  switch (provider) {
    case "claude":
      return new ClaudeAgentClient({ logger, runtimeSettings });
    case "codex":
      return new CodexAppServerAgentClient(logger, runtimeSettings, {
        customProvider: {
          id: "codex-openrouter",
          label: "Codex OpenRouter",
          extends: "codex",
        },
      });
    case "opencode":
      return new OpenCodeAgentClient(logger, runtimeSettings);
    case "pi":
      return new PiRpcAgentClient({ logger, runtimeSettings });
  }
}

export function createRealProviderClients(
  providers: readonly RealProvider[],
  logger: Logger,
): Partial<Record<AgentProvider, AgentClient>> {
  return Object.fromEntries(
    providers.map((provider) => [provider, createRealProviderClient(provider, logger)]),
  );
}

export function canRunRealProvider(provider: RealProvider): Promise<boolean> {
  const cached = availabilityCache.get(provider);
  if (cached) {
    return cached;
  }

  const availability = (async () => {
    if (!getOpenRouterApiKeyOrNull()) {
      return false;
    }
    return await isCommandAvailable(getProviderBinary(provider));
  })();

  availabilityCache.set(provider, availability);
  return availability;
}

function getOpenRouterApiKey(): string {
  const apiKey = getOpenRouterApiKeyOrNull();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for real provider tests");
  }
  return apiKey;
}

function getOpenRouterApiKeyOrNull(): string | null {
  const value = process.env.OPENROUTER_API_KEY?.trim();
  return value && value.length > 0 ? value : null;
}

function getProviderBinary(provider: RealProvider): string {
  if (provider === "pi") {
    return process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";
  }
  return provider;
}
