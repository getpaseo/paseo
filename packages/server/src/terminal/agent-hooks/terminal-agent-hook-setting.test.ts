import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonConfigStore } from "../../server/daemon-config-store.js";
import { registeredAgentHooksAreInstalled } from "./provider-registry.js";
import { applyTerminalAgentHookSetting } from "./terminal-agent-hook-setting.js";

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

function createInstallEnv(root: string) {
  return {
    env: {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      CURSOR_CONFIG_DIR: join(root, "cursor"),
      GROK_HOME: join(root, "grok"),
      OPENCODE_CONFIG_DIR: join(root, "opencode"),
    },
    homeDir: join(root, "home"),
  };
}

function hookPaths(root: string) {
  return {
    claude: join(root, "claude", "settings.json"),
    codex: join(root, "codex", "hooks.json"),
    cursor: join(root, "cursor", "hooks.json"),
    grok: join(root, "grok", "hooks", "paseo-terminal-activity.json"),
    opencode: join(root, "opencode", "plugins", "paseo-terminal-activity.js"),
  };
}

function createStore(paseoHome: string, enableTerminalAgentHooks: boolean): DaemonConfigStore {
  return new DaemonConfigStore(
    paseoHome,
    {
      mcp: { injectIntoAgents: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks,
      appendSystemPrompt: "",
    },
    undefined,
  );
}

describe("applyTerminalAgentHookSetting", () => {
  it("leaves agent configs untouched when the setting is disabled", () => {
    const root = createTempDir("paseo-hook-setting-");
    const store = createStore(createTempDir("paseo-hook-setting-home-"), false);

    applyTerminalAgentHookSetting({ store, install: createInstallEnv(root) });

    const paths = hookPaths(root);
    expect(existsSync(paths.claude)).toBe(false);
    expect(existsSync(paths.codex)).toBe(false);
    expect(existsSync(paths.cursor)).toBe(false);
    expect(existsSync(paths.grok)).toBe(false);
    expect(existsSync(paths.opencode)).toBe(false);
  });

  it("installs agent hooks when the setting is enabled", () => {
    const root = createTempDir("paseo-hook-setting-");
    const store = createStore(createTempDir("paseo-hook-setting-home-"), true);

    applyTerminalAgentHookSetting({ store, install: createInstallEnv(root) });

    const paths = hookPaths(root);
    expect(existsSync(paths.claude)).toBe(true);
    expect(existsSync(paths.codex)).toBe(true);
    expect(existsSync(paths.cursor)).toBe(true);
    expect(existsSync(paths.grok)).toBe(true);
    expect(existsSync(paths.opencode)).toBe(true);
  });

  it("installs on enable and removes hooks on disable when toggled live", () => {
    const root = createTempDir("paseo-hook-setting-");
    const store = createStore(createTempDir("paseo-hook-setting-home-"), false);
    const paths = hookPaths(root);
    const install = createInstallEnv(root);

    applyTerminalAgentHookSetting({ store, install });
    expect(existsSync(paths.opencode)).toBe(false);

    store.patch({ enableTerminalAgentHooks: true });
    expect(existsSync(paths.codex)).toBe(true);
    expect(existsSync(paths.cursor)).toBe(true);
    expect(existsSync(paths.grok)).toBe(true);
    expect(existsSync(paths.opencode)).toBe(true);
    expect(registeredAgentHooksAreInstalled(install)).toBe(true);

    store.patch({ enableTerminalAgentHooks: false });
    expect(existsSync(paths.opencode)).toBe(false);
    expect(registeredAgentHooksAreInstalled(install)).toBe(false);
    expect(readFileSync(paths.cursor, "utf8")).not.toContain("hooks cursor");
    expect(readFileSync(paths.grok, "utf8")).not.toContain("hooks grok");
  });
});
