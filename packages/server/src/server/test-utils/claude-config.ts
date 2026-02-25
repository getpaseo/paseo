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

const NO_BASE_CONFIG_DIR = Symbol("no-base-config-dir");
let baseConfigDir: string | typeof NO_BASE_CONFIG_DIR = NO_BASE_CONFIG_DIR;
const activeConfigDirs: string[] = [];

function activateClaudeConfigDir(configDir: string): void {
  if (activeConfigDirs.length === 0) {
    baseConfigDir =
      typeof process.env.CLAUDE_CONFIG_DIR === "string"
        ? process.env.CLAUDE_CONFIG_DIR
        : NO_BASE_CONFIG_DIR;
  }
  activeConfigDirs.push(configDir);
  process.env.CLAUDE_CONFIG_DIR = configDir;
}

function deactivateClaudeConfigDir(configDir: string): void {
  const index = activeConfigDirs.lastIndexOf(configDir);
  if (index !== -1) {
    activeConfigDirs.splice(index, 1);
  }
  const latestActiveDir = activeConfigDirs[activeConfigDirs.length - 1];
  if (latestActiveDir) {
    process.env.CLAUDE_CONFIG_DIR = latestActiveDir;
    return;
  }
  if (baseConfigDir === NO_BASE_CONFIG_DIR) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = baseConfigDir;
  }
  baseConfigDir = NO_BASE_CONFIG_DIR;
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
  activateClaudeConfigDir(configDir);
  return () => {
    deactivateClaudeConfigDir(configDir);
    try {
      rmSync(configDir, { recursive: true, force: true });
    } catch (error) {
      if (!isIgnorableCleanupError(error)) {
        throw error;
      }
    }
  };
}
