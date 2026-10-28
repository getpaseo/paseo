import type { ProviderCliAuthState } from "@getpaseo/protocol/provider-cli/rpc-schemas";

export interface ProviderCliCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProviderCliAuthProbe {
  args: string[];
  parse(result: ProviderCliCommandResult): Omit<ProviderCliAuthState, "supported">;
}

/**
 * How Paseo manages one provider's CLI. Only providers whose CLI the agent runtime actually
 * launches belong here: updating a binary the runtime does not use would report a fake update.
 */
export interface ProviderCliDefinition {
  provider: string;
  binary: string;
  /** npm package that publishes the CLI. Supplies the latest version and npm-installed updates. */
  npmPackage: string;
  /** The CLI's own update command, used when it was not installed through npm. */
  selfUpdateArgs: string[] | null;
  /** Interactive sign-in command, run in a PTY so the CLI prints its URL and prompts. */
  loginArgs: string[] | null;
  authProbe: ProviderCliAuthProbe | null;
}

function parseClaudeAuthStatus(
  result: ProviderCliCommandResult,
): Omit<ProviderCliAuthState, "supported"> {
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "unknown", account: null };
    }
    const record = parsed as Record<string, unknown>;
    if (record["loggedIn"] !== true) return { status: "signed_out", account: null };
    if (typeof record["email"] === "string")
      return { status: "signed_in", account: record["email"] };
    if (typeof record["authMethod"] === "string") {
      return { status: "signed_in", account: record["authMethod"] };
    }
    return { status: "signed_in", account: null };
  } catch {
    return { status: "unknown", account: null };
  }
}

function parseCodexAuthStatus(
  result: ProviderCliCommandResult,
): Omit<ProviderCliAuthState, "supported"> {
  // `codex login status` exits 0 when signed in and prints "Logged in using ChatGPT" or similar.
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (result.exitCode !== 0 || /not logged in/i.test(text)) {
    return { status: "signed_out", account: null };
  }
  const method = /logged in using (.+)/i.exec(text)?.[1]?.trim() ?? null;
  return { status: "signed_in", account: method };
}

export const PROVIDER_CLI_DEFINITIONS: readonly ProviderCliDefinition[] = [
  {
    provider: "claude",
    binary: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    selfUpdateArgs: ["update"],
    loginArgs: ["auth", "login"],
    authProbe: { args: ["auth", "status", "--json"], parse: parseClaudeAuthStatus },
  },
  {
    provider: "codex",
    binary: "codex",
    npmPackage: "@openai/codex",
    selfUpdateArgs: ["update"],
    // Device auth works when the browser is on another machine, such as a phone.
    loginArgs: ["login", "--device-auth"],
    authProbe: { args: ["login", "status"], parse: parseCodexAuthStatus },
  },
  {
    provider: "copilot",
    binary: "copilot",
    npmPackage: "@github/copilot",
    selfUpdateArgs: null,
    loginArgs: null,
    authProbe: null,
  },
  {
    provider: "opencode",
    binary: "opencode",
    npmPackage: "opencode-ai",
    selfUpdateArgs: ["upgrade"],
    loginArgs: null,
    authProbe: null,
  },
  {
    provider: "pi",
    binary: "pi",
    npmPackage: "@mariozechner/pi-coding-agent",
    selfUpdateArgs: ["update"],
    loginArgs: null,
    authProbe: null,
  },
];

export function findProviderCliDefinition(provider: string): ProviderCliDefinition | null {
  return PROVIDER_CLI_DEFINITIONS.find((definition) => definition.provider === provider) ?? null;
}
