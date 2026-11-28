/**
 * Explicit allowlist of non-secret config-directory and credential-store locator
 * environment variables read by usage sources during discovery.
 *
 * Raw auth tokens, API keys, and arbitrary custom provider env vars are never
 * included here and never cross into usage source discovery.
 */
export const USAGE_DISCOVERY_LOCATOR_ENV_KEYS = [
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

/** Keep only allowlisted non-secret config-directory / locator environment variables. */
export function filterUsageDiscoveryEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of USAGE_DISCOVERY_LOCATOR_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
}

/** Whether a provider's own configured env sets at least one allowlisted locator variable. */
export function hasConfiguredUsageLocatorEnv(
  configuredEnv: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  if (!configuredEnv) return false;
  return Object.entries(configuredEnv).some(
    ([key, value]) => value !== undefined && USAGE_DISCOVERY_LOCATOR_ENV_SET.has(key),
  );
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
export function targetsForeignUsageEndpoint(
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
