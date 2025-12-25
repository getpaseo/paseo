import { mkdtempSync, writeFileSync, copyFileSync, existsSync, rmSync } from "fs";
import { tmpdir, homedir } from "os";
import path from "path";

function copyClaudeCredentials(sourceDir: string, targetDir: string): void {
  const sourceCredentials = path.join(sourceDir, ".credentials.json");
  if (!existsSync(sourceCredentials)) {
    return;
  }
  copyFileSync(sourceCredentials, path.join(targetDir, ".credentials.json"));
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
  const sourceConfigDir =
    previousConfigDir ?? path.join(homedir(), ".claude");
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
  copyClaudeCredentials(sourceConfigDir, configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return () => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
  };
}
