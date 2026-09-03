import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_FORGE_SERVICE_METHODS,
  type PluginForgeServerProviderDescriptor,
} from "@getpaseo/plugin/server";
import { createDefaultForgeRegistry, ForgeRegistry } from "../../services/forge-registry.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginService } from "./index.js";
import { ManagedPluginSources } from "./managed-source.js";
import { runGitCommand } from "../../utils/run-git-command.js";

const roots: string[] = [];
type TestPluginRuntime = NonNullable<ConstructorParameters<typeof PluginService>[3]["runtime"]>;

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-service-"));
  roots.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }));
  await writeFile(path.join(directory, "index.server.ts"), source);
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
  dependencies: ConstructorParameters<typeof PluginService>[3] = {},
): PluginService {
  return bindTestSessionHost(
    new PluginService(pino({ level: "silent" }), createStore(home, plugins), "0.4.0", dependencies),
  );
}

function bindTestSessionHost(service: PluginService): PluginService {
  service.bindPaseoSessionHost({
    async attachPluginSocket(_pluginId, socket) {
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.on("message", (data) => {
        if (typeof data !== "string") return;
        const message = JSON.parse(data);
        if (message.type !== "hello") return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "plugin-service-test",
                hostname: "plugin-service-test",
                version: "0.4.0",
                features: {},
              },
            },
          }),
        );
      });
      return { closed };
    },
  });
  return service;
}

function catalogIds(service: PluginService): string[] {
  return service
    .catalog()
    .map(({ id }) => id)
    .sort();
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
  const runtime: TestPluginRuntime = {
    catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
    invoke: async () => undefined,
    getLogs: () => [],
    clearLogs: () => undefined,
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
    bindPaseoSessionHost: () => undefined,
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
  const runtime: TestPluginRuntime = {
    catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
    invoke: async () => undefined,
    getLogs: () => [],
    clearLogs: () => undefined,
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
    bindPaseoSessionHost: () => undefined,
  };
  return { runtime, started, releaseStart, starts };
}

function createForgeRuntime(
  descriptorOverrides: Partial<PluginForgeServerProviderDescriptor> = {},
) {
  const descriptor: PluginForgeServerProviderDescriptor = {
    definition: {
      id: "acme",
      displayName: "Acme Forge",
      changeRequestAbbrev: "CR",
      changeRequestNoun: "change request",
      changeRequestNumberPrefix: "!",
      issueNumberPrefix: "#",
      signIn: null,
      cloudHosts: ["forge.example.com"],
    },
    methods: [...PLUGIN_FORGE_SERVICE_METHODS],
    authProbeCanThrow: false,
    supportsCrossRepoCheckoutWithoutRefs: false,
    hasProbeHost: true,
    ...descriptorOverrides,
  };
  const running = new Set<string>();
  let listener: ((pluginId: string, error?: string) => void) | null = null;
  const invocations: Array<{
    pluginId: string;
    providerId: string;
    method: string;
    input: unknown;
  }> = [];
  const runtime: NonNullable<ConstructorParameters<typeof PluginService>[2]> = {
    catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
    forgeProviders: (pluginId) => (running.has(pluginId) ? [descriptor] : []),
    invoke: async () => undefined,
    invokeForge: async (pluginId, providerId, method, input) => {
      invocations.push({ pluginId, providerId, method, input });
      if (method === "probeHost") return input === "self-hosted.example.com";
      if (method === "isAuthenticated") return true;
      if (method === "invalidate" || method === "dispose") return undefined;
      throw new Error(`Unexpected Forge invocation: ${method}`);
    },
    getLogs: () => [],
    clearLogs: () => undefined,
    startPlugin: async (pluginId, _path, canPublish) => {
      if (!canPublish()) throw new Error(`Plugin start cancelled: ${pluginId}`);
      running.add(pluginId);
    },
    stopPluginById: async (pluginId) => running.delete(pluginId),
    stopAll: async () => {
      running.clear();
    },
    subscribe: (nextListener) => {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
    bindPaseoSessionHost: () => undefined,
  };
  return {
    runtime,
    invocations,
    running,
    crash(pluginId: string) {
      running.delete(pluginId);
      listener?.(pluginId, `Plugin process exited: ${pluginId}`);
    },
  };
}

function createPausedStopForgeRuntime() {
  const forge = createForgeRuntime();
  let releaseStop = () => undefined;
  let markStopStarted = () => undefined;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const stopStarted = new Promise<void>((resolve) => {
    markStopStarted = resolve;
  });
  forge.runtime.stopPluginById = async (pluginId) => {
    const removed = forge.running.delete(pluginId);
    markStopStarted();
    await stopGate;
    return removed;
  };
  return { ...forge, stopStarted, releaseStop };
}

describe("PluginService", () => {
  it("registers plugin Forge providers and detaches them for every stop path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      forge: { source: "directory", path: "/plugins/forge", enabled: true },
    });
    const forgeRegistry = new ForgeRegistry();
    const first = createForgeRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: first.runtime,
      forgeRegistry,
    });

    await service.start();
    expect(forgeRegistry.definition("acme")).toMatchObject({
      displayName: "Acme Forge",
      changeRequestAbbrev: "CR",
    });
    expect(forgeRegistry.matchHost("forge.example.com")).toBe("acme");
    await expect(forgeRegistry.probeHost("self-hosted.example.com")).resolves.toBe("acme");
    await expect(forgeRegistry.create("acme")?.isAuthenticated({ cwd: "/repo" })).resolves.toBe(
      true,
    );

    await service.reloadPlugin("forge");
    expect(forgeRegistry.has("acme")).toBe(true);

    await service.disablePlugin("forge");
    expect(forgeRegistry.has("acme")).toBe(false);

    await service.enablePlugin("forge");
    expect(forgeRegistry.has("acme")).toBe(true);
    first.crash("forge");
    expect(forgeRegistry.has("acme")).toBe(false);

    await service.enablePlugin("forge");
    expect(forgeRegistry.has("acme")).toBe(true);
    await service.removePlugin("forge");
    expect(forgeRegistry.has("acme")).toBe(false);
  });

  it("publishes the detached catalog before a reload cleanup finishes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      forge: { source: "directory", path: "/plugins/forge", enabled: true },
    });
    const forgeRegistry = new ForgeRegistry();
    const paused = createPausedStopForgeRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: paused.runtime,
      forgeRegistry,
    });
    await service.start();
    const snapshots: string[][] = [];
    service.subscribe(() => snapshots.push(catalogIds(service)));

    const reloading = service.reloadPlugin("forge");
    await paused.stopStarted;

    expect(forgeRegistry.has("acme")).toBe(false);
    expect(service.catalog()).toEqual([]);
    expect(snapshots).toEqual([[]]);

    paused.releaseStop();
    await expect(reloading).resolves.toMatchObject({ status: "running" });
    expect(forgeRegistry.has("acme")).toBe(true);
    expect(snapshots).toEqual([[], ["forge"]]);
  });

  it("publishes a disable before cleanup and does not duplicate it afterward", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      forge: { source: "directory", path: "/plugins/forge", enabled: true },
    });
    const forgeRegistry = new ForgeRegistry();
    const paused = createPausedStopForgeRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: paused.runtime,
      forgeRegistry,
    });
    await service.start();
    const snapshots: string[][] = [];
    service.subscribe(() => snapshots.push(catalogIds(service)));

    const disabling = service.disablePlugin("forge");
    await paused.stopStarted;

    expect(forgeRegistry.has("acme")).toBe(false);
    expect(service.catalog()).toEqual([]);
    expect(service.listPlugins()).toEqual([
      { id: "forge", path: "/plugins/forge", enabled: false, status: "disabled" },
    ]);
    expect(snapshots).toEqual([[]]);

    paused.releaseStop();
    await expect(disabling).resolves.toMatchObject({ status: "disabled" });
    expect(snapshots).toEqual([[]]);
  });

  it("publishes a removal before cleanup and keeps the Forge detached afterward", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      forge: { source: "directory", path: "/plugins/forge", enabled: true },
    });
    const forgeRegistry = new ForgeRegistry();
    const paused = createPausedStopForgeRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: paused.runtime,
      forgeRegistry,
    });
    await service.start();
    const snapshots: string[][] = [];
    service.subscribe(() => snapshots.push(catalogIds(service)));

    const removing = service.removePlugin("forge");
    await paused.stopStarted;

    expect(forgeRegistry.has("acme")).toBe(false);
    expect(service.catalog()).toEqual([]);
    expect(service.listPlugins()).toEqual([]);
    expect(snapshots).toEqual([[]]);

    paused.releaseStop();
    await removing;
    expect(forgeRegistry.has("acme")).toBe(false);
    expect(snapshots).toEqual([[], []]);
  });

  it("fails a plugin whose Forge id collides with a built-in adapter", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      forge: { source: "directory", path: "/plugins/forge", enabled: true },
    });
    const forgeRegistry = createDefaultForgeRegistry();
    const fake = createForgeRuntime({
      definition: {
        id: "github",
        displayName: "Fake GitHub",
        changeRequestAbbrev: "PR",
        changeRequestNoun: "pull request",
        changeRequestNumberPrefix: "#",
        issueNumberPrefix: "#",
        signIn: null,
      },
    });
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: fake.runtime,
      forgeRegistry,
    });

    await service.start();

    expect(fake.running.has("forge")).toBe(false);
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({
        id: "forge",
        status: "failed",
        error: "Forge adapter already registered: github",
      }),
    ]);
    expect(forgeRegistry.definition("github")?.displayName).toBe("GitHub");
  });

  it("retains logs when disabled and clears them only when removed", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const entries = [
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout" as const,
        message: "ready",
      },
    ];
    const cleared: string[] = [];
    const runtime: TestPluginRuntime = {
      catalog: () => [],
      invoke: async () => undefined,
      getLogs: () => entries,
      clearLogs: (pluginId) => {
        cleared.push(pluginId);
        entries.length = 0;
      },
      startPlugin: async () => undefined,
      stopPluginById: async () => false,
      stopAll: async () => undefined,
      subscribe: () => () => undefined,
      bindPaseoSessionHost: () => undefined,
    };
    const service = createService(
      home,
      { example: { source: "directory", path: "/plugins/example", enabled: false } },
      { runtime },
    );

    expect(service.getLogs("example")).toEqual(entries);
    await service.disablePlugin("example");
    expect(service.getLogs("example")).toEqual(entries);
    expect(cleared).toEqual([]);

    await service.removePlugin("example");
    expect(cleared).toEqual(["example"]);
    expect(entries).toEqual([]);
  });

  it("publishes each configured plugin after its startup state settles", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const first = await createPlugin(
      "startup-first",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const second = await createPlugin(
      "startup-second",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const service = createService(home, {
      "startup-first": { source: "directory", path: first },
      "startup-second": { source: "directory", path: second },
    });
    const snapshots: string[][] = [];
    service.subscribe(() => snapshots.push(catalogIds(service)));

    await service.start();

    expect(snapshots).toEqual([["startup-first"], ["startup-first", "startup-second"]]);
    await service.stopAllPlugins();
  }, 20_000);

  it("uses an explicit config key, exposes reload failure, and retries from disk", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const directory = await createPlugin(
      "manifest-default",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const store = createStore(home);
    const service = bindTestSessionHost(
      new PluginService(pino({ level: "silent" }), store, "0.4.0"),
    );
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

    await writeFile(path.join(directory, "index.server.ts"), "export default broken syntax !!!");
    await expect(service.reloadPlugin("work-plugin")).rejects.toThrow();
    expect(service.catalog()).toEqual([]);
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({ id: "work-plugin", status: "failed", error: expect.any(String) }),
    ]);

    await writeFile(
      path.join(directory, "index.server.ts"),
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    await expect(service.reloadPlugin("work-plugin")).resolves.toMatchObject({ status: "running" });
    await service.stopAllPlugins();
  }, 20_000);

  it("prefers an existing directory and installs its selected plugin subdirectory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const repository = await mkdtemp(path.join(tmpdir(), "owner-repository-"));
    roots.push(repository);
    const pluginDirectory = path.join(repository, "plugins", "review");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      path.join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({ id: "local-monorepo" }),
    );
    await writeFile(
      path.join(pluginDirectory, "index.server.ts"),
      "export default function contribute(plugin: unknown) { void plugin; return () => undefined; }",
    );
    const service = createService(home);
    await service.start();

    await expect(
      service.installSource({ source: `${repository}:plugins/review` }),
    ).resolves.toMatchObject({ id: "local-monorepo", path: pluginDirectory, status: "running" });
    await service.stopAllPlugins();
  }, 20_000);

  it("keeps the running commit when a Git update build command fails", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const repository = await mkdtemp(path.join(tmpdir(), "paseo-plugin-repository-"));
    roots.push(repository);
    await runGitCommand(["init", "-b", "main"], { cwd: repository });
    await runGitCommand(["config", "user.name", "Paseo Tests"], { cwd: repository });
    await runGitCommand(["config", "user.email", "paseo@example.test"], { cwd: repository });
    await writeFile(
      path.join(repository, "paseo-plugin.json"),
      JSON.stringify({ id: "git-update" }),
    );
    await writeFile(
      path.join(repository, "index.server.ts"),
      "export default function contribute(plugin: unknown) { void plugin; return () => undefined; }",
    );
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "initial"], { cwd: repository });

    const store = createStore(home);
    const service = bindTestSessionHost(
      new PluginService(pino({ level: "silent" }), store, "0.4.0", {
        managedSources: new ManagedPluginSources(home),
      }),
    );
    await service.start();
    const installed = await service.installSource({ source: pathToFileURL(repository).href });
    const installedPath = installed.path;
    const installedCommit = installed.commit;

    await writeFile(
      path.join(repository, "paseo-plugin.json"),
      JSON.stringify({
        id: "git-update",
        build: [
          [process.execPath, "-e", 'process.stderr.write("build exploded") ; process.exit(1)'],
        ],
      }),
    );
    await writeFile(
      path.join(repository, "index.server.ts"),
      'export default function contribute(plugin: unknown) { void plugin; throw new Error("broken update"); }',
    );
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "broken update"], { cwd: repository });

    await expect(service.updateSources("git-update")).rejects.toThrow();
    expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
    expect(service.catalog()).toEqual([
      expect.objectContaining({ id: "git-update", clientBundle: expect.any(String) }),
    ]);
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({
        id: "git-update",
        path: installedPath,
        commit: installedCommit,
        status: "running",
      }),
    ]);
    await service.stopAllPlugins();
  }, 30_000);

  it("runs Git build commands in staging before validation and activation on install and update", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const repository = await mkdtemp(path.join(tmpdir(), "paseo-plugin-repository-"));
    roots.push(repository);
    await runGitCommand(["init", "-b", "main"], { cwd: repository });
    await runGitCommand(["config", "user.name", "Paseo Tests"], { cwd: repository });
    await runGitCommand(["config", "user.email", "paseo@example.test"], { cwd: repository });
    await writeFile(
      path.join(repository, "paseo-plugin.json"),
      JSON.stringify({
        id: "prepared-git-plugin",
        build: [
          [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], "prepared")',
            "build-marker;touch shell-injection",
          ],
        ],
      }),
    );
    await writeFile(path.join(repository, "index.server.ts"), "export default () => () => {};\n");
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "initial"], { cwd: repository });

    const events: string[] = [];
    const running = new Set<string>();
    const runtime: TestPluginRuntime = {
      catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
      invoke: async () => undefined,
      getLogs: () => [],
      clearLogs: () => undefined,
      validatePlugin: async (directory) => {
        events.push(
          `validate:${await readFile(path.join(directory, "build-marker;touch shell-injection"), "utf8")}`,
        );
      },
      startPlugin: async (pluginId) => {
        events.push("start");
        running.add(pluginId);
      },
      stopPluginById: async (pluginId) => running.delete(pluginId),
      stopAll: async () => running.clear(),
      subscribe: () => () => undefined,
      bindPaseoSessionHost: () => undefined,
    };
    const service = createService(
      home,
      {},
      {
        runtime,
        managedSources: new ManagedPluginSources(home),
      },
    );
    await service.start();

    const installed = await service.installSource({ source: pathToFileURL(repository).href });

    expect(events).toEqual(["validate:prepared", "start"]);
    await expect(stat(path.join(installed.path, "shell-injection"))).rejects.toThrow();

    await writeFile(
      path.join(repository, "paseo-plugin.json"),
      JSON.stringify({
        id: "prepared-git-plugin",
        build: [
          [
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync("build-marker;touch shell-injection", "updated")',
          ],
        ],
      }),
    );
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "prepared update"], { cwd: repository });

    await expect(service.updateSources("prepared-git-plugin")).resolves.toEqual([
      expect.objectContaining({ id: "prepared-git-plugin", updated: true }),
    ]);
    expect(events).toEqual(["validate:prepared", "start", "validate:updated", "start"]);
    await service.stopAllPlugins();
  }, 30_000);

  it("activates an update when the enabled plugin previously failed to start", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const repository = await mkdtemp(path.join(tmpdir(), "paseo-plugin-repository-"));
    roots.push(repository);
    await runGitCommand(["init", "-b", "main"], { cwd: repository });
    await runGitCommand(["config", "user.name", "Paseo Tests"], { cwd: repository });
    await runGitCommand(["config", "user.email", "paseo@example.test"], { cwd: repository });
    await writeFile(
      path.join(repository, "paseo-plugin.json"),
      JSON.stringify({ id: "failed-update" }),
    );
    await writeFile(path.join(repository, "index.server.ts"), "export default () => () => {};\n");
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "initial"], { cwd: repository });

    const managedSources = new ManagedPluginSources(home);
    let initial = await managedSources.prepareInstall({
      source: pathToFileURL(repository).href,
    });
    initial = await managedSources.place("failed-update", initial);
    managedSources.commit("failed-update", initial.record);

    const running = new Set<string>();
    const starts: string[] = [];
    let failNextStart = true;
    const runtime: TestPluginRuntime = {
      catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
      invoke: async () => undefined,
      getLogs: () => [],
      clearLogs: () => undefined,
      validatePlugin: async () => undefined,
      startPlugin: async (pluginId, sourcePath, canPublish) => {
        starts.push(sourcePath);
        if (failNextStart) {
          failNextStart = false;
          throw new Error("initial start failed");
        }
        if (canPublish()) running.add(pluginId);
      },
      stopPluginById: async (pluginId) => running.delete(pluginId),
      stopAll: async () => running.clear(),
      subscribe: () => () => undefined,
      bindPaseoSessionHost: () => undefined,
    };
    const store = createStore(home, {
      "failed-update": { source: "directory", path: initial.directory, enabled: true },
    });
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime,
      managedSources,
    });
    await service.start();
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({ id: "failed-update", status: "failed" }),
    ]);

    await writeFile(
      path.join(repository, "index.server.ts"),
      "export default () => () => { new Date(); };\n",
    );
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "fixed"], { cwd: repository });

    await expect(service.updateSources("failed-update")).resolves.toEqual([
      expect.objectContaining({ id: "failed-update", updated: true }),
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[1]).not.toBe(initial.directory);
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({ id: "failed-update", path: starts[1], status: "running" }),
    ]);
    await service.stopAllPlugins();
  }, 30_000);

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
    const service = bindTestSessionHost(
      new PluginService(pino({ level: "silent" }), store, "0.4.0"),
    );
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
  }, 20_000);

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
    const service = bindTestSessionHost(
      new PluginService(pino({ level: "silent" }), store, "0.4.0"),
    );
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
  }, 30_000);

  it("does not publish an in-flight start after a later global disable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const store = createStore(home, {
      slow: { source: "directory", path: "/plugins/slow", enabled: true },
    });
    store.patch({ pluginsEnabled: false });
    const paused = createPausedRuntime();
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: paused.runtime,
    });
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
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: paused.runtime,
    });
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
    const service = new PluginService(pino({ level: "silent" }), store, "0.4.0", {
      runtime: paused.runtime,
    });
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
  }, 20_000);

  it("reports invalid manifests, missing entries, and startup failures", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const invalid = await createPlugin("valid-before-corruption", "export default () => () => {};");
    await writeFile(path.join(invalid, "paseo-plugin.json"), JSON.stringify({}));
    const missingEntry = await createPlugin("missing-entry", "export default () => () => {};");
    await rm(path.join(missingEntry, "index.server.ts"));
    const startupFailure = await createPlugin(
      "startup-failure",
      `export default function contribute(plugin: unknown) { void plugin; throw new Error("startup exploded"); }`,
    );
    const service = createService(home);
    await service.start();

    await expect(service.installDirectory({ path: invalid })).rejects.toThrow();
    await expect(service.installDirectory({ path: missingEntry })).rejects.toThrow(
      "Plugin entry points are missing",
    );
    await expect(service.installDirectory({ path: startupFailure })).rejects.toThrow(
      "startup exploded",
    );
    expect(service.listPlugins()).toEqual([
      expect.objectContaining({
        id: "missing-entry",
        status: "failed",
        error: expect.stringContaining("Plugin entry points are missing"),
      }),
      expect.objectContaining({
        id: "startup-failure",
        status: "failed",
        error: "startup exploded",
      }),
    ]);
    await service.stopAllPlugins();
  }, 20_000);

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
  }, 30_000);
});
