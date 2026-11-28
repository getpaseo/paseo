/**
 * Explicit allowlist of non-secret config-directory and credential-store locator
 * environment variables read by usage sources during host discovery.
 *
 * Raw auth tokens, API keys, and arbitrary custom provider env vars are never
 * included here and never cross into usage source discovery.
 */
const USAGE_DISCOVERY_LOCATOR_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "USER",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "OMP_PROFILE",
  "KIMI_CODE_HOME",
  "AGENT_CLI_CREDENTIAL_STORE",
] as const;

const USAGE_DISCOVERY_LOCATOR_ENV_SET: ReadonlySet<string> = new Set(
  USAGE_DISCOVERY_LOCATOR_ENV_KEYS,
);

function filterUsageDiscoveryEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of USAGE_DISCOVERY_LOCATOR_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
}

function isEnabledFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

/**
 * Whether a provider's effective launch environment routes requests away from its
 * base provider's first-party OAuth / subscription quota store (for example Bedrock,
 * Vertex, a custom proxy base URL, or an API-key override for Cursor). Evaluated
 * daemon-side so neither endpoint URLs nor auth secrets cross into usage plugins.
 */
function targetsForeignUsageEndpoint(
  baseProvider: string,
  effectiveEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  if (baseProvider === "claude") {
    const baseUrl = effectiveEnv.ANTHROPIC_BASE_URL;
    const foreignUrl =
      Boolean(baseUrl) && baseUrl!.replace(/\/+$/, "") !== "https://api.anthropic.com";
    return (
      isEnabledFlag(effectiveEnv.CLAUDE_CODE_USE_BEDROCK) ||
      isEnabledFlag(effectiveEnv.CLAUDE_CODE_USE_VERTEX) ||
      foreignUrl
    );
  }
  if (baseProvider === "codex") {
    return Boolean(effectiveEnv.OPENAI_BASE_URL);
  }
  if (baseProvider === "cursor") {
    return Boolean(effectiveEnv.CURSOR_API_KEY || effectiveEnv.CURSOR_AUTH_TOKEN);
  }
  return false;
}

export interface SelectProviderUsageEnvInput {
  provider: string;
  env: Readonly<Record<string, string | undefined>>;
  configuredEnvKeys?: readonly string[];
}

/**
 * Resolve the sanitized locator environment for configured-provider host discovery,
 * or `null` when the provider configures no locator variable or targets a foreign endpoint.
 */
export function selectProviderUsageEnv({
  provider,
  env,
  configuredEnvKeys,
}: SelectProviderUsageEnvInput): Record<string, string> | null {
  if (
    configuredEnvKeys !== undefined &&
    !configuredEnvKeys.some(
      (key) => env[key] !== undefined && USAGE_DISCOVERY_LOCATOR_ENV_SET.has(key),
    )
  ) {
    return null;
  }
  if (targetsForeignUsageEndpoint(provider, env)) return null;
  const sanitized = filterUsageDiscoveryEnv(env);
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}
