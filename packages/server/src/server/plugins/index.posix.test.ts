import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginService } from "./index.js";

const roots: string[] = [];

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-service-"));
  roots.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }));
  await writeFile(path.join(directory, "index.tsx"), source);
  return directory;
}

function createStore(
  home: string,
  plugins: Record<string, { source: "directory"; path: string; enabled?: boolean }> = {},
): DaemonConfigStore {
  return new DaemonConfigStore(home, {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    pluginsEnabled: true,
    plugins,
  });
}

function createService(
  home: string,
  plugins: Record<string, { source: "directory"; path: string; enabled?: boolean }> = {},
  runtime?: ConstructorParameters<typeof PluginService>[2],
): PluginService {
  return new PluginService(pino({ level: "silent" }), createStore(home, plugins), runtime);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createPausedRuntime() {
  let releaseStart = () => undefined;
  let markStarted = () => undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const running = new Set<string>();
  const runtime: NonNullable<ConstructorParameters<typeof PluginService>[2]> = {
    catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
    invoke: async () => undefined,
    startPlugin: async (pluginId, _path, canPublish) => {
      markStarted();
      await startGate;
      if (!canPublish()) throw new Error(`Plugin start cancelled: ${pluginId}`);
      running.add(pluginId);
    },
    stopPluginById: async (pluginId) => running.delete(pluginId),
    stopAll: async () => {
      running.clear();
    },
    subscribe: () => () => undefined,
  };
  return { runtime, started, releaseStart };
}

function createPluginSelectivePausedRuntime(pausedPluginId: string) {
  let releaseStart = () => undefined;
  let markStarted = () => undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const starts: string[] = [];
  const running = new Set<string>();
  const runtime: NonNullable<ConstructorParameters<typeof PluginService>[2]> = {
    catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
    invoke: async () => undefined,
    startPlugin: async (pluginId, _path, canPublish) => {
      starts.push(pluginId);
      if (pluginId === pausedPluginId) {
        markStarted();
        await startGate;
      }
      if (!canPublish()) throw new Error(`Plugin start cancelled: ${pluginId}`);
      running.add(pluginId);
    },
    stopPluginById: async (pluginId) => running.delete(pluginId),
    stopAll: async () => {
      running.clear();
    },
    subscribe: () => () => undefined,
  };
  return { runtime, started, releaseStart, starts };
}

describe("PluginService", () => {
  it("uses an explicit config key, exposes reload failure, and retries from disk", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const directory = await createPlugin(
      "manifest-default",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const store = createStore(home);
    const service = new PluginService(pino({ level: "silent" }), store);
    await service.start();

    await expect(
      service.installDirectory({ path: directory, id: "work-plugin" }),
    ).resolves.toMatchObject({
      id: "work-plugin",
      status: "running",
    });
    await expect(service.installDirectory({ path: directory, id: "work-plugin" })).rejects.toThrow(
      "choose another ID with --id",
    );

    await writeFile(path.join(directory, "index.tsx"), "export default broken syntax !!!");
    await expect(service.reloadPlugin("work-plugin")).rejects.toThrow();
    expect(service.catalog()).toEqual([]);
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({ id: "work-plugin", status: "failed", error: expect.any(String) }),
    ]);

    await writeFile(
      path.join(directory, "index.tsx"),
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    await expect(service.reloadPlugin("work-plugin")).resolves.toMatchObject({ status: "running" });
    await service.stopAllPlugins();
  });

  it("disables and removes a plugin without touching its source directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const cleanupFile = path.join(home, "cleanup.txt");
    const directory = await createPlugin(
      "cleanup-plugin",
      `import { writeFileSync } from "node:fs";
export default function contribute(plugin: unknown) {
  void plugin;
  return () => writeFileSync(${JSON.stringify(cleanupFile)}, "cleaned");
}`,
    );
    const store = createStore(home);
    const service = new PluginService(pino({ level: "silent" }), store);
    await service.start();
    await service.installDirectory({ path: directory });

    await expect(service.disablePlugin("cleanup-plugin")).resolves.toMatchObject({
      status: "disabled",
    });
    expect(await readFile(cleanupFile, "utf8")).toBe("cleaned");
    await service.removePlugin("cleanup-plugin");

    expect(service.listPlugins()).toEqual([]);
    await expect(stat(directory)).resolves.toMatchObject({});
    await service.stopAllPlugins();
  });

  it("detaches every plugin synchronously when the global switch turns off and recovers", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const first = await createPlugin(
      "first",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const second = await createPlugin(
      "second",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const store = createStore(home);
    const service = new PluginService(pino({ level: "silent" }), store);
    await service.start();
    await service.installDirectory({ path: first });
    await service.installDirectory({ path: second });

    store.patch({ pluginsEnabled: false });

    expect(service.catalog()).toEqual([]);
    await expect(service.invokePluginRpc("second", "anything", {})).rejects.toThrow(
      "Plugin is not available",
    );
    store.patch({ pluginsEnabled: true });
    await service.reloadPlugin("first");
    expect(service.listPlugins().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "first", status: "running" },
      { id: "second", status: "running" },
    ]);
    await service.stopAllPlugins();
  });

  it("does not publish an in-flight start after a later global disable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      slow: { source: "directory", path: "/plugins/slow", enabled: true },
    });
    store.patch({ pluginsEnabled: false });
    const paused = createPausedRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, paused.runtime);
    await service.start();

    store.patch({ pluginsEnabled: true });
    await paused.started;
    store.patch({ pluginsEnabled: false });
    paused.releaseStart();
    await service.stopAllPlugins();

    expect(service.catalog()).toEqual([]);
    expect(service.listPlugins()).toEqual([
      { id: "slow", path: "/plugins/slow", enabled: true, status: "disabled" },
    ]);
  });

  it("does not publish an in-flight enable after a later plugin disable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      slow: { source: "directory", path: "/plugins/slow", enabled: false },
    });
    const paused = createPausedRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, paused.runtime);
    await service.start();

    const enabling = expect(service.enablePlugin("slow")).rejects.toThrow(
      "Plugin start cancelled: slow",
    );
    await paused.started;
    const disabling = service.disablePlugin("slow");
    paused.releaseStart();

    await enabling;
    await expect(disabling).resolves.toMatchObject({ status: "disabled" });
    expect(service.catalog()).toEqual([]);
  });

  it("keeps a later disable authoritative over an enable waiting behind another plugin", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      occupier: { source: "directory", path: "/plugins/occupier", enabled: false },
      slow: { source: "directory", path: "/plugins/slow", enabled: false },
    });
    const paused = createPluginSelectivePausedRuntime("occupier");
    const service = new PluginService(pino({ level: "silent" }), store, paused.runtime);
    await service.start();

    const occupying = service.enablePlugin("occupier");
    await paused.started;
    const enabling = service.enablePlugin("slow");
    const disabling = service.disablePlugin("slow");
    paused.releaseStart();

    await occupying;
    await expect(enabling).resolves.toMatchObject({
      id: "slow",
      enabled: false,
      status: "disabled",
    });
    await expect(disabling).resolves.toMatchObject({
      id: "slow",
      enabled: false,
      status: "disabled",
    });
    expect(paused.starts).toEqual(["occupier"]);
    expect(service.catalog()).toEqual([{ id: "occupier", clientBundle: "bundle" }]);
  });

  it("notifies exactly once after successful and failed configured installs", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const successful = await createPlugin(
      "successful-install",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const failed = await createPlugin(
      "failed-install",
      `export default function contribute(plugin: unknown) { void plugin; throw new Error("startup exploded"); }`,
    );
    const service = createService(home);
    const events: string[] = [];
    service.subscribe((pluginId) => events.push(pluginId));
    await service.start();

    await service.installDirectory({ path: successful });
    expect(events).toEqual(["successful-install"]);

    events.length = 0;
    await expect(service.installDirectory({ path: failed })).rejects.toThrow("startup exploded");
    expect(events).toEqual(["failed-install"]);
    await service.stopAllPlugins();
  });

  it("reports invalid manifests, missing entries, and startup failures", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const invalid = await createPlugin("valid-before-corruption", "export default () => () => {};");
    await writeFile(path.join(invalid, "paseo-plugin.json"), JSON.stringify({}));
    const missingEntry = await createPlugin("missing-entry", "export default () => () => {};");
    await rm(path.join(missingEntry, "index.tsx"));
    const startupFailure = await createPlugin(
      "startup-failure",
      `export default function contribute(plugin: unknown) { void plugin; throw new Error("startup exploded"); }`,
    );
    const service = createService(home);
    await service.start();

    await expect(service.installDirectory({ path: invalid })).rejects.toThrow();
    await expect(service.installDirectory({ path: missingEntry })).rejects.toThrow(
      "Plugin entry point is missing",
    );
    await expect(service.installDirectory({ path: startupFailure })).rejects.toThrow(
      "startup exploded",
    );
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({
        id: "missing-entry",
        status: "failed",
        error: expect.stringContaining("Plugin entry point is missing"),
      }),
      expect.objectContaining({
        id: "startup-failure",
        status: "failed",
        error: "startup exploded",
      }),
    ]);
    await service.stopAllPlugins();
  });

  it("contains cleanup errors and invokes server cleanup once per stopped installation", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const cleanupFile = path.join(home, "cleanups.txt");
    const directory = await createPlugin(
      "cleanup-count",
      `import { appendFileSync } from "node:fs";
export default function contribute(plugin: unknown) {
  void plugin;
  return () => {
    appendFileSync(${JSON.stringify(cleanupFile)}, "cleanup\\n");
    throw new Error("cleanup exploded");
  };
}`,
    );
    const service = createService(home);
    await service.start();
    await service.installDirectory({ path: directory });
    await service.reloadPlugin("cleanup-count");
    await service.disablePlugin("cleanup-count");
    await service.enablePlugin("cleanup-count");
    await service.removePlugin("cleanup-count");
    await service.installDirectory({ path: directory });
    await service.stopAllPlugins();

    expect((await readFile(cleanupFile, "utf8")).trim().split("\n")).toHaveLength(4);
  });
});
