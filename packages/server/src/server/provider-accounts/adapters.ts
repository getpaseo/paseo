import type { ProviderAccountProvider } from "@getpaseo/protocol/provider-accounts";
import type { ProcessEnvRecord } from "../paseo-env.js";
import type { ProviderAccountRecord } from "./store.js";

export interface ProviderAccountLaunchSpec {
  envOverlay: ProcessEnvRecord;
}

export interface ProviderAccountAdapter {
  readonly provider: ProviderAccountProvider;
  launchSpec(account: ProviderAccountRecord): ProviderAccountLaunchSpec;
}

const CODEX_AUTH_ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
const CLAUDE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

function accountEnvironment(
  runtimeHomeKey: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
  runtimeHome: string,
  authKeys: readonly string[],
): ProcessEnvRecord {
  const envOverlay: ProcessEnvRecord = { [runtimeHomeKey]: runtimeHome };
  for (const key of authKeys) envOverlay[key] = undefined;
  return envOverlay;
}

const codexAdapter: ProviderAccountAdapter = {
  provider: "codex",
  launchSpec: (account) => ({
    envOverlay: accountEnvironment("CODEX_HOME", account.runtimeHome, CODEX_AUTH_ENV_KEYS),
  }),
};

const claudeAdapter: ProviderAccountAdapter = {
  provider: "claude",
  launchSpec: (account) => ({
    envOverlay: accountEnvironment("CLAUDE_CONFIG_DIR", account.runtimeHome, CLAUDE_AUTH_ENV_KEYS),
  }),
};

const adapters: Record<ProviderAccountProvider, ProviderAccountAdapter> = {
  codex: codexAdapter,
  claude: claudeAdapter,
};

export function getProviderAccountAdapter(
  provider: ProviderAccountProvider,
): ProviderAccountAdapter {
  return adapters[provider];
}
