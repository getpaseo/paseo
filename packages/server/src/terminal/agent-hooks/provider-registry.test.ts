import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  uninstallAgentHooks,
} from "./agent-hook-installer.js";
import {
  AGENT_HOOK_PROVIDERS,
  installRegisteredAgentHooks,
  resolveHookActivity,
} from "./provider-registry.js";

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

describe("Copilot terminal agent hooks", () => {
  it("installs and removes only its own hooks", () => {
    const configDir = createTempDir("paseo-copilot-config-");
    const provider = AGENT_HOOK_PROVIDERS.copilot;
    const options = { configDir };
    const first = installAgentHooks(provider, options);
    const config = JSON.parse(readFileSync(first.configPath, "utf8")) as {
      version: number;
      hooks: Record<string, Array<{ type: string; bash?: string; powershell?: string }>>;
    };
    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks)).toEqual(["userPromptSubmitted", "agentStop"]);
    expect(installAgentHooks(provider, options).changed).toBe(false);
    expect(agentHooksAreInstalled(provider, options)).toBe(true);
    const userHook = { type: "command", bash: "echo hooks copilot user-hook" };
    config.hooks.agentStop.push(userHook);
    writeFileSync(first.configPath, `${JSON.stringify(config, null, 2)}\n`);
    installAgentHooks(provider, options);
    uninstallAgentHooks(provider, options);
    const after = JSON.parse(readFileSync(first.configPath, "utf8")) as typeof config;
    expect(after.hooks).toEqual({ agentStop: [userHook] });
    expect(agentHooksAreInstalled(provider, options)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("only runs the hook in a Paseo terminal", () => {
    const configDir = createTempDir("paseo-copilot-command-");
    const result = installAgentHooks(AGENT_HOOK_PROVIDERS.copilot, { configDir });
    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as {
      hooks: Record<string, Array<{ bash: string }>>;
    };
    const bin = join(configDir, "fake cli");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o700 });
    for (const event of ["userPromptSubmitted", "agentStop"]) {
      const command = config.hooks[event][0].bash;
      const env = { ...process.env, PASEO_HOOK_CLI: bin, PASEO_TERMINAL_ID: "" };
      expect(spawnSync("sh", ["-c", command], { env, encoding: "utf8" }).stdout).toBe("");
      const run = spawnSync("sh", ["-c", command], {
        env: { ...env, PASEO_TERMINAL_ID: "terminal" },
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toBe(`hooks copilot ${event}\n`);
    }
  });

  it.each([
    ["userPromptSubmitted", "running"],
    ["agentStop", "idle"],
    ["subagentStop", null],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      resolveHookActivity({ provider: "copilot", event, input: { read: async () => null } }),
    ).resolves.toBe(state);
  });
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
      join(root, "home", ".copilot", "hooks", "paseo-terminal-activity.json"),
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
