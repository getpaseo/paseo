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
import { opencodeV2AgentHookProvider } from "./opencode-v2.js";
import { OPENCODE_V2_PLUGIN_SOURCE } from "./opencode-v2-plugin.js";

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

describe("OpenCode v2 terminal agent hooks", () => {
  it("installs a self-contained OpenCode v2 plugin idempotently", () => {
    const configDir = createTempDir("paseo-opencode-v2-config-");

    const firstInstall = installAgentHooks(opencodeV2AgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(opencodeV2AgentHookProvider, { configDir });

    expect(firstInstall.configPath).toBe(
      join(configDir, "plugins", "paseo-terminal-activity-v2.js"),
    );
    expect(firstInstall.changed).toBe(true);
    expect(secondInstall.changed).toBe(false);
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe(OPENCODE_V2_PLUGIN_SOURCE);
    expect(agentHooksAreInstalled(opencodeV2AgentHookProvider, { configDir })).toBe(true);
  });

  it("writes the v2 plugin using Plugin.define, ctx.event.subscribe, and the opencode-v2 marker", () => {
    const configDir = createTempDir("paseo-opencode-v2-config-source-");
    const { configPath } = installAgentHooks(opencodeV2AgentHookProvider, { configDir });
    const source = readFileSync(configPath, "utf8");

    expect(source).toContain("Plugin.define");
    expect(source).toContain("ctx.event?.subscribe");
    expect(source).toContain('"paseo", "hooks", "opencode-v2"');
    expect(source).toContain("PASEO_HOOK_CLI");
    expect(source).toContain("PASEO_TERMINAL_ID");
    expect(source).toContain('"permission.asked"');
    expect(source).toContain('"form.created"');
    expect(source).toContain('"form.replied"');
    expect(source).toContain('"form.cancelled"');
  });

  it("uninstalls the OpenCode v2 plugin file", () => {
    const configDir = createTempDir("paseo-opencode-v2-config-uninstall-");
    const configPath = resolveAgentHookConfigPath(opencodeV2AgentHookProvider, { configDir });
    installAgentHooks(opencodeV2AgentHookProvider, { configDir });

    const result = uninstallAgentHooks(opencodeV2AgentHookProvider, { configDir });

    expect(result).toEqual({ configPath, changed: true });
    expect(existsSync(configPath)).toBe(false);
    expect(agentHooksAreInstalled(opencodeV2AgentHookProvider, { configDir })).toBe(false);
  });

  it("prefers OPENCODE_CONFIG_DIR over the XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");
    const configDir = createTempDir("paseo-opencode-v2-override-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeV2AgentHookProvider, {
      env: { OPENCODE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(join(configDir, "plugins", "paseo-terminal-activity-v2.js"));
  });

  it("uses the XDG config home for the default OpenCode v2 config dir", () => {
    const homeDir = createTempDir("paseo-home-");
    const xdgConfigHome = createTempDir("paseo-xdg-config-");

    const configPath = resolveAgentHookConfigPath(opencodeV2AgentHookProvider, {
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      homeDir,
    });

    expect(configPath).toBe(
      join(xdgConfigHome, "opencode", "plugins", "paseo-terminal-activity-v2.js"),
    );
  });

  it("falls back to the home .config OpenCode dir without an XDG config home", () => {
    const homeDir = createTempDir("paseo-home-");

    const configPath = resolveAgentHookConfigPath(opencodeV2AgentHookProvider, {
      env: {},
      homeDir,
    });

    expect(configPath).toBe(
      join(homeDir, ".config", "opencode", "plugins", "paseo-terminal-activity-v2.js"),
    );
  });

  it.each([
    ["session.status.busy", "running"],
    ["session.status.retry", "running"],
    ["session.status.idle", "idle"],
    ["permission.asked", "needs-input"],
    ["form.created", "needs-input"],
    ["permission.replied", "running"],
    ["form.replied", "running"],
    ["form.cancelled", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      opencodeV2AgentHookProvider.resolveActivity({
        event,
        input: { read: async () => null },
      }),
    ).resolves.toBe(state);
  });

  it("resolves unknown events to null", async () => {
    await expect(
      opencodeV2AgentHookProvider.resolveActivity({
        event: "session.unknown",
        input: { read: async () => null },
      }),
    ).resolves.toBeNull();
  });
});
