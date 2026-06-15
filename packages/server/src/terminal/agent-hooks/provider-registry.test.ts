import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installRegisteredAgentHooks } from "./provider-registry.js";

const temporaryDirs: string[] = [];

interface WarningLogEntry {
  bindings: Record<string, unknown>;
  message: string;
}

interface WarningLogger {
  entries: WarningLogEntry[];
  warn(bindings: Record<string, unknown>, message: string): void;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function createWarningLogger(): WarningLogger {
  return {
    entries: [],
    warn(bindings, message) {
      this.entries.push({ bindings, message });
    },
  };
}

describe("terminal agent hook provider registry", () => {
  it("continues installing provider hooks after one provider fails", () => {
    const root = createTempDir("paseo-agent-hook-registry-");
    const badClaudeConfigDir = join(root, "not-a-directory");
    const codexHome = join(root, "codex");
    const opencodeConfigDir = join(root, "opencode");
    const logger = createWarningLogger();
    writeFileSync(badClaudeConfigDir, "");

    const results = installRegisteredAgentHooks({
      env: {
        CLAUDE_CONFIG_DIR: badClaudeConfigDir,
        CODEX_HOME: codexHome,
        OPENCODE_CONFIG_DIR: opencodeConfigDir,
      },
      homeDir: join(root, "home"),
      logger,
    });

    expect(results.map((result) => result.configPath)).toEqual([
      join(codexHome, "hooks.json"),
      join(opencodeConfigDir, "plugins", "paseo-terminal-activity.js"),
    ]);
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(true);
    expect(existsSync(join(opencodeConfigDir, "plugins", "paseo-terminal-activity.js"))).toBe(true);
    expect(logger.entries).toEqual([
      {
        bindings: expect.objectContaining({ err: expect.any(Error), provider: "claude" }),
        message: "Failed to install terminal activity hook provider",
      },
    ]);
  });
});
