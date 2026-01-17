import { existsSync, copyFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";

/**
 * Validates that Claude credentials are likely available for testing.
 * This check ensures tests fail-fast with a clear error if known auth
 * mechanisms are missing, rather than hanging or timing out.
 *
 * Note: Claude Code supports multiple auth methods (API key, session token,
 * OAuth/Pro subscription). This check validates known file/env-based methods.
 * OAuth users may not have .credentials.json but can still authenticate.
 *
 * @throws Error with actionable message if Claude credentials are unavailable
 */
export function validateClaudeAuth(): void {
  // Check for environment variables first (preferred for CI)
  const sessionTokenEnv = process.env.CLAUDE_SESSION_TOKEN;
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY;

  if (sessionTokenEnv || apiKeyEnv) {
    return;
  }

  // Check for credentials file in the default config directory
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  const credentialsPath = path.join(configDir, ".credentials.json");

  if (existsSync(credentialsPath)) {
    return;
  }

  // Check if Claude config directory exists (suggests Claude Code is installed)
  // OAuth users won't have .credentials.json but will have the config directory
  if (existsSync(configDir)) {
    // Claude is installed, assume OAuth or other auth method is configured
    return;
  }

  // No credentials found via any known method
  throw new Error(
    "Claude credentials not found. Please provide credentials via:\n" +
    "  1. Environment variables: CLAUDE_SESSION_TOKEN or ANTHROPIC_API_KEY\n" +
    "  2. Local config file: ~/.claude/.credentials.json\n" +
    "  3. OAuth login: Run `claude login` to authenticate\n" +
    "\n" +
    "For CI: Set CLAUDE_SESSION_TOKEN or ANTHROPIC_API_KEY in GitHub Actions secrets\n" +
    "For local development: Run `claude login` or create ~/.claude/.credentials.json"
  );
}

/**
 * Seeds a temp CLAUDE_CONFIG_DIR with minimal authentication state needed for tests.
 *
 * This utility ensures Claude provider calls (like haiku) work deterministically in
 * both local test runs and CI by copying credentials from either:
 * 1. Environment variables (CI/preferred approach)
 * 2. Developer's real ~/.claude config directory (local fallback)
 *
 * @param targetDir - The temporary CLAUDE_CONFIG_DIR to seed with auth state
 * @throws Error with actionable message if Claude credentials are unavailable
 */
export function seedClaudeAuth(targetDir: string): void {
  // First, try to use credentials from environment variables (preferred for CI)
  const sessionTokenEnv = process.env.CLAUDE_SESSION_TOKEN;
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY;

  if (sessionTokenEnv || apiKeyEnv) {
    // Create credentials from environment variables
    const credentials: Record<string, unknown> = {};

    if (sessionTokenEnv) {
      credentials.sessionToken = sessionTokenEnv;
    }

    if (apiKeyEnv) {
      credentials.apiKey = apiKeyEnv;
    }

    const credentialsPath = path.join(targetDir, ".credentials.json");
    writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), "utf8");
    return;
  }

  // Fallback: Copy credentials from developer's real config directory
  const sourceConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  const sourceCredentials = path.join(sourceConfigDir, ".credentials.json");

  if (!existsSync(sourceCredentials)) {
    throw new Error(
      "Claude credentials not found. Please provide credentials via:\n" +
      "  1. Environment variables: CLAUDE_SESSION_TOKEN or ANTHROPIC_API_KEY\n" +
      "  2. Local config file: ~/.claude/.credentials.json\n" +
      "\n" +
      "For CI: Set CLAUDE_SESSION_TOKEN or ANTHROPIC_API_KEY in GitHub Actions secrets\n" +
      "For local development: Run `claude login` or create ~/.claude/.credentials.json"
    );
  }

  const targetCredentials = path.join(targetDir, ".credentials.json");
  copyFileSync(sourceCredentials, targetCredentials);
}
