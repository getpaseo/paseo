import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  resolveAgentHookConfigPath,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { opencodeAgentHookProvider } from "./opencode.js";
import { OPENCODE_PLUGIN_SOURCE } from "./opencode-plugin.js";

const temporaryDirs: string[] = [];

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

describe("OpenCode terminal agent hooks", () => {
  it("installs a self-contained OpenCode plugin idempotently", () => {
    const configDir = createTempDir("paseo-opencode-config-");

    const firstInstall = installAgentHooks(opencodeAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(opencodeAgentHookProvider, { configDir });

    expect(firstInstall.configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity.js"));
    expect(firstInstall.changed).toBe(true);
    expect(secondInstall.changed).toBe(false);
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe(OPENCODE_PLUGIN_SOURCE);
    expect(agentHooksAreInstalled(opencodeAgentHookProvider, { configDir })).toBe(true);
  });

  it("writes the plugin that maps OpenCode bus events to paseo hook events", () => {
    const configDir = createTempDir("paseo-opencode-config-source-");
    const { configPath } = installAgentHooks(opencodeAgentHookProvider, { configDir });
    const source = readFileSync(configPath, "utf8");

    expect(source).toContain('busy: "session.status.busy"');
    expect(source).toContain('retry: "session.status.retry"');
    expect(source).toContain('idle: "session.status.idle"');
    expect(source).toContain('event?.type === "permission.asked"');
    expect(source).toContain('event?.type === "permission.replied"');
    expect(source).toContain('Bun.spawn(["paseo", "hooks", "opencode", event]');
    expect(source).toContain("PASEO_TERMINAL_ID");
  });

  it("uninstalls the OpenCode plugin file", () => {
    const configDir = createTempDir("paseo-opencode-config-uninstall-");
    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, { configDir });
    installAgentHooks(opencodeAgentHookProvider, { configDir });

    const result = uninstallAgentHooks(opencodeAgentHookProvider, { configDir });

    expect(result).toEqual({ configPath, changed: true });
    expect(existsSync(configPath)).toBe(false);
    expect(agentHooksAreInstalled(opencodeAgentHookProvider, { configDir })).toBe(false);
  });

  it("prefers OPENCODE_CONFIG_DIR over the XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");
    const configDir = createTempDir("paseo-opencode-override-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity.js"));
  });

  it("uses the XDG config home for the default OpenCode config dir", () => {
    const homeDir = createTempDir("paseo-home-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(
      join(xdgConfigHome, "opencode", "plugins", "paseo-terminal-activity.js"),
    );
  });

  it("falls back to the home .config OpenCode dir without an XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");

    const configPath = resolveAgentHookConfigPath(opencodeAgentHookProvider, {
      env: {},
      homeDir,
    });

    expect(configPath).toBe(
      join(homeDir, ".config", "opencode", "plugins", "paseo-terminal-activity.js"),
    );
  });

  it.each([
    ["session.status.busy", "running"],
    ["session.status.retry", "running"],
    ["session.status.idle", "idle"],
    ["permission.asked", "needs-input"],
    ["permission.replied", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      opencodeAgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });
});
