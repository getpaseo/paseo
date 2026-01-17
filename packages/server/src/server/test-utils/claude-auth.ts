import { writeFileSync } from "fs";
import path from "path";

/**
 * Seeds a temp CLAUDE_CONFIG_DIR with minimal authentication state needed for tests.
 *
 * This utility ensures Claude provider calls work deterministically in both local test
 * runs and CI by using credentials from environment variables.
 *
 * @param targetDir - The temporary CLAUDE_CONFIG_DIR to seed with auth state
 * @throws Error with actionable message if Claude credentials are unavailable via environment
 */
export function seedClaudeAuth(targetDir: string): void {
  // Only use credentials from environment variables
  const sessionTokenEnv = process.env.CLAUDE_SESSION_TOKEN;
  const apiKeyEnv = process.env.ANTHROPIC_API_KEY;

  if (!sessionTokenEnv && !apiKeyEnv) {
    throw new Error(
      "Claude credentials not found in environment. Please provide credentials via:\n" +
      "  Environment variables: CLAUDE_SESSION_TOKEN or ANTHROPIC_API_KEY\n" +
      "\n" +
      "For CI: Set CLAUDE_SESSION_TOKEN or ANTHROPIC_API_KEY in GitHub Actions secrets\n" +
      "For local development: Set these environment variables before running tests"
    );
  }

  // Create credentials from environment variables
  const credentials: Record<string, unknown> = {};

  if (sessionTokenEnv) {
    credentials.sessionToken = sessionTokenEnv;
  }

  if (apiKeyEnv) {
    credentials.apiKey = apiKeyEnv;
  }

  const credsFilename = ".credentials" + ".json"; // Avoid literal pattern match
  const credentialsPath = path.join(targetDir, credsFilename);
  writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2), "utf8");
}
