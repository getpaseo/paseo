import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { seedClaudeAuth } from "./claude-auth.js";

function isIgnorableCleanupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
}

/**
 * Sets up an isolated Claude config directory for testing.
 * Creates a temp directory with:
 * - settings.json with ask: ["Bash(rm:*)"] to trigger permission prompts
 * - settings.local.json with the same settings
 * - .credentials.json copied from user's real config
 *
 * Sets CLAUDE_CONFIG_DIR env var to point to the temp directory.
 * Returns a cleanup function that restores the original env and removes the temp dir.
 */
export function useTempClaudeConfigDir(): () => void {
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = mkdtempSync(path.join(tmpdir(), "claude-config-"));
  const settings = {
    permissions: {
      allow: [],
      deny: [],
      ask: ["Bash(rm:*)"],
      additionalDirectories: [],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
    },
  };
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
  writeFileSync(path.join(configDir, "settings.json"), settingsText, "utf8");
  writeFileSync(path.join(configDir, "settings.local.json"), settingsText, "utf8");
  seedClaudeAuth(configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return () => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch (error) {
      if (!isIgnorableCleanupError(error)) {
        throw error;
      }
    }
  };
}
