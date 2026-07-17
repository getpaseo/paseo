import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";

import type { Logger } from "pino";

import type { AgentClient, AgentProvider, AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../agent/provider-launch-config.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { OmpAgentClient } from "../agent/providers/omp/agent.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";

export const realProviders = ["claude", "codex", "opencode", "pi", "omp"] as const;
export type RealProvider = (typeof realProviders)[number];
export type RealProviderConfig = Pick<
  AgentSessionConfig,
  "provider" | "model" | "modeId" | "thinkingOptionId"
>;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const OPENROUTER_OPENAI_BASE_URL = "https://openrouter.ai/api";
const PI_AUTH_CONFIG_PATH = join(homedir(), ".pi", "agent", "auth.json");
const CODEX_AUTH_CONFIG_PATH = join(homedir(), ".codex", "auth.json");
const CLAUDE_REAL_TEST_MODEL = "haiku";
const CODEX_REAL_TEST_MODEL = "~openai/gpt-latest";
const OPENCODE_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";
const PI_OPENROUTER_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";
const PI_CODEX_REAL_TEST_MODEL = "openai-codex/gpt-5.4";
const OMP_OPENROUTER_REAL_TEST_MODEL = "openrouter/google/gemini-2.5-flash-lite";
const OMP_CODEX_REAL_TEST_MODEL = "openai-codex/gpt-5.6-sol";

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
        model: getPiRealTestModel(),
        thinkingOptionId: "medium",
      };
    case "omp":
      return {
        provider,
        model: getOmpRealTestModel(),
        thinkingOptionId: "medium",
        modeId: "full",
      };
  }
}

export function getRealProviderRuntimeSettings(provider: RealProvider): ProviderRuntimeSettings {
  if (provider === "omp" || provider === "pi") {
    if (hasCodexAuthTokens()) {
      return {
        env: {
          // Clear stale shell-level keys so the local CLI auth stores win.
          OPENAI_API_KEY: "",
        },
      };
    }
    const apiKey = getOpenRouterApiKeyOrNull();
    if (apiKey) {
      return {
        env: {
          OPENROUTER_API_KEY: apiKey,
          OPENAI_API_KEY: "",
        },
      };
    }
    return {};
  }
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
      return {};
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
    case "omp":
      return new OmpAgentClient({ logger, runtimeSettings });
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
    if (provider !== "omp" && provider !== "pi" && !getOpenRouterApiKeyOrNull()) {
      return false;
    }
    return await isCommandAvailable(getProviderBinary(provider));
  })();

  availabilityCache.set(provider, availability);
  return availability;
}

function getOmpRealTestModel(): string {
  const configured = process.env.OMP_REAL_TEST_MODEL?.trim();
  if (configured) {
    return configured;
  }
  return hasCodexAuthTokens() ? OMP_CODEX_REAL_TEST_MODEL : OMP_OPENROUTER_REAL_TEST_MODEL;
}

function getPiRealTestModel(): string {
  const configured = process.env.PI_REAL_TEST_MODEL?.trim();
  if (configured) {
    return configured;
  }
  return hasCodexAuthTokens() ? PI_CODEX_REAL_TEST_MODEL : PI_OPENROUTER_REAL_TEST_MODEL;
}

function getOpenRouterApiKey(): string {
  const apiKey = getOpenRouterApiKeyOrNull();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for real provider tests");
  }
  return apiKey;
}

function getOpenRouterApiKeyOrNull(): string | null {
  const value = readPiOpenRouterApiKey() ?? process.env.OPENROUTER_API_KEY?.trim();
  return value && value.length > 0 ? value : null;
}

function readPiOpenRouterApiKey(): string | null {
  const auth = readJsonFile(PI_AUTH_CONFIG_PATH);
  const value =
    auth && typeof auth === "object" && "openrouter" in auth ? auth.openrouter : undefined;
  if (!value || typeof value !== "object" || value === null || !("key" in value)) {
    return null;
  }
  return typeof value.key === "string" && value.key.trim().length > 0 ? value.key.trim() : null;
}

function hasCodexAuthTokens(): boolean {
  const auth = readJsonFile(CODEX_AUTH_CONFIG_PATH);
  if (!auth || typeof auth !== "object" || !("tokens" in auth)) {
    return false;
  }
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== "object") {
    return false;
  }
  return (
    (typeof tokens.access_token === "string" && tokens.access_token.length > 0) ||
    (typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0)
  );
}

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function getProviderBinary(provider: RealProvider): string {
  if (provider === "pi") {
    return process.env.PI_COMMAND ?? process.env.PI_ACP_PI_COMMAND ?? "pi";
  }
  if (provider === "omp") {
    return process.env.OMP_COMMAND ?? "omp";
  }
  return provider;
}
