import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { loadConfig, resolveReloadableConfig } from "./config.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { resolveDaemonToolsFromConfigOptions } from "./tools-config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-tools-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon.tools config resolution and backward compatibility", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("defaults tools.enabled to true and browser group to false on fresh installs", async () => {
    const home = await createPaseoHome({ version: 1 });
    const config = loadConfig(home, { env: {} });

    expect(config.tools).toEqual({
      enabled: true,
      groups: {
        orchestration: true,
        schedules: true,
        changeRequests: true,
        browser: false,
      },
    });
    expect(config.mcpInjectIntoAgents).toBe(true);
    expect(config.browserToolsEnabled).toBe(false);
  });

  test("reads explicit daemon.tools config including individual group overrides", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: {
        tools: {
          enabled: true,
          groups: {
            orchestration: false,
            schedules: false,
            changeRequests: true,
            browser: true,
          },
        },
      },
    });
    const config = loadConfig(home, { env: {} });

    expect(config.tools).toEqual({
      enabled: true,
      groups: {
        orchestration: false,
        schedules: false,
        changeRequests: true,
        browser: true,
      },
    });
    expect(config.browserToolsEnabled).toBe(true);
  });

  test("falls back to legacy daemon.mcp.enabled and daemon.mcp.injectIntoAgents when daemon.tools is absent", async () => {
    const disabledMcpHome = await createPaseoHome({
      version: 1,
      daemon: { mcp: { enabled: false } },
    });
    expect(loadConfig(disabledMcpHome, { env: {} }).tools?.enabled).toBe(false);

    const disabledInjectHome = await createPaseoHome({
      version: 1,
      daemon: { mcp: { enabled: true, injectIntoAgents: false } },
    });
    expect(loadConfig(disabledInjectHome, { env: {} }).tools?.enabled).toBe(false);

    const enabledInjectHome = await createPaseoHome({
      version: 1,
      daemon: { mcp: { enabled: true, injectIntoAgents: true } },
    });
    expect(loadConfig(enabledInjectHome, { env: {} }).tools?.enabled).toBe(true);
  });

  test("falls back to legacy daemon.browserTools.enabled when daemon.tools.groups.browser is absent", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { browserTools: { enabled: true } },
    });
    const config = loadConfig(home, { env: {} });

    expect(config.tools).toEqual({
      enabled: true,
      groups: {
        orchestration: true,
        schedules: true,
        changeRequests: true,
        browser: true,
      },
    });
    expect(config.browserToolsEnabled).toBe(true);
  });

  test("prefers explicit daemon.tools over legacy daemon.mcp and daemon.browserTools fields", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: {
        mcp: { enabled: false, injectIntoAgents: false },
        browserTools: { enabled: true },
        tools: {
          enabled: true,
          groups: { browser: false },
        },
      },
    });
    const config = loadConfig(home, { env: {} });

    expect(config.tools).toEqual({
      enabled: true,
      groups: {
        orchestration: true,
        schedules: true,
        changeRequests: true,
        browser: false,
      },
    });
    expect(config.browserToolsEnabled).toBe(false);
  });

  test("preserves legacy CLI override flags (--no-mcp, --no-inject-mcp)", async () => {
    const home = await createPaseoHome({
      version: 1,
      daemon: { tools: { enabled: true } },
    });

    expect(loadConfig(home, { env: {}, cli: { mcpEnabled: false } }).tools?.enabled).toBe(false);
    expect(loadConfig(home, { env: {}, cli: { mcpInjectIntoAgents: false } }).tools?.enabled).toBe(
      false,
    );
  });

  test("DaemonConfigStore patches tools, preserves group choices across master off/on, and syncs legacy fields", async () => {
    const home = await createPaseoHome({ version: 1 });
    const store = new DaemonConfigStore(home, {
      relay: { enabled: false },
      tools: {
        enabled: true,
        groups: {
          orchestration: true,
          schedules: true,
          changeRequests: true,
          browser: false,
        },
      },
      mcp: { enabled: true, injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const browserPolicy = new DaemonConfigBrowserToolsPolicy(store);

    expect(browserPolicy.isEnabled()).toBe(false);

    await store.patch({ tools: { groups: { browser: true, schedules: false } } });
    expect(store.get().tools).toEqual({
      enabled: true,
      groups: {
        orchestration: true,
        schedules: false,
        changeRequests: true,
        browser: true,
      },
    });
    expect(store.get().browserTools.enabled).toBe(true);
    expect(browserPolicy.isEnabled()).toBe(true);

    // Turning master switch off disables browser policy while preserving saved group selections.
    await store.patch({ tools: { enabled: false } });
    expect(store.get().tools).toEqual({
      enabled: false,
      groups: {
        orchestration: true,
        schedules: false,
        changeRequests: true,
        browser: true,
      },
    });
    expect(store.get().mcp.injectIntoAgents).toBe(false);
    expect(browserPolicy.isEnabled()).toBe(false);

    // Turning master switch back on restores saved group selections.
    await store.patch({ tools: { enabled: true } });
    expect(store.get().tools?.groups).toEqual({
      orchestration: true,
      schedules: false,
      changeRequests: true,
      browser: true,
    });
    expect(store.get().mcp.injectIntoAgents).toBe(true);
    expect(browserPolicy.isEnabled()).toBe(true);
    expect(loadPersistedConfig(home).daemon?.tools).toEqual({
      enabled: true,
      groups: {
        schedules: false,
        browser: true,
      },
    });
  });

  test("legacy patches update tools and live reload applies daemon.tools changes without restart", async () => {
    const home = await createPaseoHome({ version: 1 });
    const toMutable = (persisted: ReturnType<typeof loadPersistedConfig>) => {
      const reloaded = resolveReloadableConfig(persisted, { env: {} });
      const tools = resolveDaemonToolsFromConfigOptions({
        tools: reloaded.tools,
        mcpEnabled: reloaded.mcpEnabled,
        mcpInjectIntoAgents: reloaded.mcpInjectIntoAgents,
        browserToolsEnabled: reloaded.browserToolsEnabled,
      });
      return {
        mutable: {
          relay: { enabled: false },
          tools,
          mcp: { enabled: reloaded.mcpEnabled ?? true, injectIntoAgents: tools.enabled },
          browserTools: { enabled: tools.groups.browser },
          providers: {},
          metadataGeneration: { providers: [] },
          autoArchiveAfterMerge: false,
          enableTerminalAgentHooks: false,
          appendSystemPrompt: "",
        },
        overrideControlledPaths: reloaded.overrideControlledPaths,
      };
    };
    const initial = loadPersistedConfig(home);
    const store = new DaemonConfigStore(home, toMutable(initial).mutable, undefined, {
      startupPersisted: initial,
      reloadSource: { resolve: toMutable },
    });

    await store.patch({ mcp: { injectIntoAgents: false }, browserTools: { enabled: true } });
    expect(store.get().tools).toEqual({
      enabled: false,
      groups: {
        orchestration: true,
        schedules: true,
        changeRequests: true,
        browser: true,
      },
    });

    await store.patch({ tools: { enabled: false, groups: { browser: true } } });
    const persistedAfterPatch = loadPersistedConfig(home);
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        ...persistedAfterPatch,
        daemon: {
          ...persistedAfterPatch.daemon,
          tools: {
            enabled: true,
            groups: { orchestration: false, schedules: true, changeRequests: false, browser: true },
          },
        },
      }),
    );

    const reloadResult = await store.reload();
    expect(reloadResult.restartRequiredPaths).toEqual([]);
    expect(reloadResult.appliedPaths).toEqual([
      "daemon.tools.enabled",
      "daemon.tools.groups.changeRequests",
      "daemon.tools.groups.orchestration",
    ]);
    expect(store.get().tools).toEqual({
      enabled: true,
      groups: {
        orchestration: false,
        schedules: true,
        changeRequests: false,
        browser: true,
      },
    });
  });
});
