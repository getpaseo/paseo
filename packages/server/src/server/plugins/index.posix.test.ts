import { randomUUID } from "node:crypto";
import { rename, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../../scripts/test-support/npm-registry.mjs";
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
    getClientPresence: () => ({ userPresent: false, clients: [] }),
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
  const runtime: TestPluginRuntime = {
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
  it("resolves a provider icon path to sanitized inline SVG", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const directory = await createPlugin(
      "provider-icon",
      `export default function contribute(server) {
  server.registerProvider({
    id: "plugin-agent",
    label: "Plugin agent",
    icon: "icon.svg",
    async getCatalogCacheKey(options) { return options.scope === "workspace" ? "runtime:" + options.cwd : undefined; },
    async connect() { throw new Error("not opened by this test"); },
  });
  return () => {};
}`,
    );
    const iconSvg = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>';
    await writeFile(path.join(directory, "icon.svg"), iconSvg);
    const service = createService(home);

    await service.start();
    await service.installDirectory({ path: directory });

    expect(service.getProviderRegistrations()).toMatchObject([
      { id: "plugin-agent", icon: iconSvg, getCatalogCacheKey: expect.any(Function) },
    ]);
    const provider = service.getProviderRegistrations()[0]!;
    expect(await provider.getCatalogCacheKey!({ scope: "workspace", cwd: "/project-a" })).toBe(
      "runtime:/project-a",
    );
    expect(
      await provider.getCatalogCacheKey!({ scope: "workspace", cwd: "/project-b", force: true }),
    ).toBe("runtime:/project-b");
    expect(await provider.getCatalogCacheKey!({ scope: "global" })).toBeUndefined();
  });

  it("publishes provider registrations only while their plugin is running", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const directory = await createPlugin(
      "provider-lifecycle",
      `export default function contribute(server) {
  server.registerProvider({
    id: "plugin-agent",
    label: "Plugin agent",
    async connect() { throw new Error("not opened by this test"); },
  });
  return () => {};
}`,
    );
    const service = createService(home);

    await service.start();
    await service.installDirectory({ path: directory });
    expect(service.getProviderRegistrations()).toMatchObject([
      { id: "plugin-agent", label: "Plugin agent" },
    ]);

    await service.disablePlugin("provider-lifecycle");
    expect(service.getProviderRegistrations()).toEqual([]);
  });

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
    expect(await service.listPlugins()).toMatchObject([
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
    expect(await service.listPlugins()).toEqual([]);
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
    expect(await service.listPlugins()).toEqual([
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
    expect(await service.listPlugins()).toMatchObject([
      expect.objectContaining({ id: "work-plugin", status: "failed", error: expect.any(String) }),
    ]);

    await writeFile(
      path.join(directory, "index.server.ts"),
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    await expect(service.reloadPlugin("work-plugin")).resolves.toMatchObject({ status: "running" });
    await service.stopAllPlugins();
  }, 20_000);

  it("lists manifest descriptions for running and disabled plugins without hiding malformed entries", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-home-"));
    roots.push(home);
    const running = await createPlugin("running", "export default () => () => {};");
    const disabled = await createPlugin("disabled", "export default () => () => {};");
    const malformed = await createPlugin("malformed", "export default () => () => {};");
    await writeFile(
      path.join(running, "paseo-plugin.json"),
      JSON.stringify({ id: "running", description: "Runs checks" }),
    );
    await writeFile(
      path.join(disabled, "paseo-plugin.json"),
      JSON.stringify({ id: "disabled", description: "Waits until enabled" }),
    );
    await writeFile(path.join(malformed, "paseo-plugin.json"), "{");
    const service = createService(home, {
      running: { source: "directory", path: running },
      disabled: { source: "directory", path: disabled, enabled: false },
      malformed: { source: "directory", path: malformed },
    });

    await service.start();

    expect(
      (await service.listPlugins()).map(({ id, description }) => ({ id, description })),
    ).toEqual([
      { id: "disabled", description: "Waits until enabled" },
      { id: "malformed", description: undefined },
      { id: "running", description: "Runs checks" },
    ]);
    await service.stopAllPlugins();
  });

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

  it.each([true, false])(
    "updates the shipped legacy Git layout with enabled=%s",
    async (enabled) => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-legacy-layout-"));
      roots.push(home);
      const repository = await mkdtemp(path.join(tmpdir(), "paseo-legacy-remote-"));
      roots.push(repository);
      const id = "legacy-review";
      const pluginPath = "plugins/review";
      await mkdir(path.join(repository, pluginPath), { recursive: true });
      await writeFile(
        path.join(repository, pluginPath, "paseo-plugin.json"),
        JSON.stringify({ id, requirements: { paseo: ">=0.8.0" } }),
      );
      await writeFile(
        path.join(repository, pluginPath, "index.server.ts"),
        `import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
export default function contribute(server: PluginServerContext) {
  server.registerSettings(defineSettings({ id: "preferences", scope: "host", version: 1, schema: z.object({ message: z.string().default("default") }) }));
  return () => {};
}`,
      );
      for (const args of [
        ["init", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"],
        ["tag", "v1"],
      ])
        await runGitCommand(args, { cwd: repository });
      const initial = (
        await runGitCommand(["rev-parse", "HEAD"], { cwd: repository })
      ).stdout.trim();
      const remote = pathToFileURL(repository).href;
      const legacyRoot = path.join(home, "plugins", id, `${initial.slice(0, 12)}-${randomUUID()}`);
      const checkoutRoot = path.join(legacyRoot, "checkout");
      const directory = path.join(checkoutRoot, pluginPath);
      await mkdir(legacyRoot, { recursive: true });
      await runGitCommand(["clone", remote, checkoutRoot], { cwd: home });
      await runGitCommand(["checkout", "--detach", "v1"], { cwd: checkoutRoot });
      await writeFile(
        path.join(home, "plugins", "sources.json"),
        JSON.stringify({
          [id]: {
            remote,
            requestedRef: "v1",
            trackingBranch: null,
            commit: "f".repeat(40),
            pluginPath,
            checkoutRoot,
          },
        }),
      );
      const settingsDirectory = path.join(home, "plugin-settings");
      await mkdir(path.join(settingsDirectory, id), { recursive: true });
      const settingsFile = path.join(settingsDirectory, id, "preferences.json");
      const savedSettings = JSON.stringify({ version: 1, values: { message: "keep my settings" } });
      await writeFile(settingsFile, savedSettings);
      const store = createStore(home, { [id]: { source: "directory", path: directory, enabled } });
      const open = () =>
        bindTestSessionHost(
          new PluginService(pino({ level: "silent" }), store, "0.8.0", {
            managedSources: new ManagedPluginSources(home),
            settingsDirectory,
          }),
        );
      let service = open();
      try {
        await service.start();
        const expected = {
          identity: { kind: "git", remote, pluginPath },
          currentRevision: initial,
        };
        await rename(repository, `${repository}-offline`);
        try {
          expect(await new ManagedPluginSources(home).describe(id, directory)).toEqual(expected);
          expect(await service.listPlugins()).toMatchObject([
            { id, enabled, status: enabled ? "running" : "disabled", installation: expected },
          ]);
        } finally {
          await rename(`${repository}-offline`, repository);
        }
        await service.stopAllPlugins();
        service = open();
        await service.start();
        await runGitCommand(["checkout", "-b", "new-default"], { cwd: repository });
        await writeFile(path.join(repository, pluginPath, "revision.txt"), "new default");
        for (const args of [
          ["add", "."],
          ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "update"],
        ])
          await runGitCommand(args, { cwd: repository });
        const latest = (
          await runGitCommand(["rev-parse", "HEAD"], { cwd: repository })
        ).stdout.trim();
        const [preview] = await service.previewUpdates({ pluginId: id });
        expect(preview).toMatchObject({
          outcome: "update",
          current: expected,
          target: { kind: "git", commit: latest },
        });
        const [updated] = await service.applyUpdates([preview!.proposal!]);
        expect(updated).toMatchObject({
          outcome: "updated",
          plugin: {
            id,
            enabled,
            status: enabled ? "running" : "disabled",
            installation: { identity: expected.identity, currentRevision: latest },
          },
        });
        await expect(stat(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(settingsFile, "utf8")).toBe(savedSettings);
        await service.disablePlugin(id);
        await service.enablePlugin(id);
        expect(await service.reloadPlugin(id)).toMatchObject({ status: "running" });
        expect(await service.invokePluginRpc(id, "settings.preferences.read", {})).toMatchObject({
          status: "ready",
          values: { message: "keep my settings" },
        });
        await service.removePlugin(id);
        await expect(stat(path.join(home, "plugins", id))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await stat(repository)).toBeDefined();
        const sources = new ManagedPluginSources(home);
        // A record cannot confer ownership on another plugin's tree or a malformed version name.
        sources.commit(id, { kind: "git", remote });
        for (const outside of [
          path.join(home, "plugins", "other", path.basename(legacyRoot), "checkout"),
          path.join(home, "plugins", id, "f".repeat(36), "checkout"),
          path.join(home, "plugins", id, `${initial.slice(0, 12)}-invalid`, "checkout"),
        ])
          await expect(sources.describe(id, outside)).rejects.toThrow(
            "outside its managed installation",
          );
      } finally {
        await service.stopAllPlugins();
      }
    },
    30_000,
  );

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

    expect(await applyReviewedUpdate(service, "git-update")).toMatchObject([
      { outcome: "error", error: expect.stringContaining("build exploded") },
    ]);
    expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
    expect(service.catalog()).toEqual([
      expect.objectContaining({ id: "git-update", clientBundle: expect.any(String) }),
    ]);
    expect(await service.listPlugins()).toMatchObject([
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

    await expect(applyReviewedUpdate(service, "prepared-git-plugin")).resolves.toEqual([
      expect.objectContaining({ id: "prepared-git-plugin", outcome: "updated" }),
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
    expect(await service.listPlugins()).toMatchObject([
      expect.objectContaining({ id: "failed-update", status: "failed" }),
    ]);

    await writeFile(
      path.join(repository, "index.server.ts"),
      "export default () => () => { new Date(); };\n",
    );
    await runGitCommand(["add", "-A"], { cwd: repository });
    await runGitCommand(["commit", "-m", "fixed"], { cwd: repository });

    await expect(applyReviewedUpdate(service, "failed-update")).resolves.toEqual([
      expect.objectContaining({ id: "failed-update", outcome: "updated" }),
    ]);
    expect(starts).toHaveLength(2);
    expect(starts[1]).not.toBe(initial.directory);
    expect(await service.listPlugins()).toMatchObject([
      expect.objectContaining({ id: "failed-update", path: starts[1], status: "running" }),
    ]);
    await service.stopAllPlugins();
  }, 30_000);

  it.each([false, true])(
    "cleans a failed update when restoration also fails=%s",
    async (failRestore) => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-recovery-"));
      roots.push(home);
      const repository = await createPlugin("recovery", "export default () => () => {};\n");
      for (const args of [
        ["init", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"],
      ])
        await runGitCommand(args, { cwd: repository });
      const running = new Set<string>();
      let starts = 0;
      const runtime: TestPluginRuntime = {
        catalog: () => [...running].map((id) => ({ id, clientBundle: "bundle" })),
        invoke: async () => undefined,
        getLogs: () => [],
        clearLogs: () => undefined,
        validatePlugin: async () => undefined,
        startPlugin: async (id) => {
          starts++;
          if (starts === 2) throw new Error("candidate activation failed");
          if (starts === 3 && failRestore) throw new Error("prior activation failed");
          running.add(id);
        },
        stopPluginById: async (id) => running.delete(id),
        stopAll: async () => running.clear(),
        subscribe: () => () => undefined,
        bindPaseoSessionHost: () => undefined,
      };
      const service = createService(
        home,
        {},
        { runtime, managedSources: new ManagedPluginSources(home) },
      );
      await service.start();
      const installed = await service.installSource({ source: pathToFileURL(repository).href });
      await writeFile(path.join(repository, "revision.txt"), "new");
      for (const args of [
        ["add", "."],
        ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "update"],
      ])
        await runGitCommand(args, { cwd: repository });
      const result = await applyReviewedUpdate(service, "recovery");
      expect(result).toMatchObject([
        {
          outcome: "error",
          error: expect.stringContaining(
            failRestore ? "restoring previous plugin also failed" : "candidate activation failed",
          ),
        },
      ]);
      expect(await service.listPlugins()).toMatchObject([
        {
          path: installed.path,
          enabled: true,
          status: failRestore ? "failed" : "running",
          installation: installed.installation,
        },
      ]);
      expect(await readdir(path.join(home, "plugins", "recovery"))).toEqual([
        path.basename(path.dirname(installed.path)),
      ]);
      expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      await service.stopAllPlugins();
    },
    30_000,
  );

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

    expect(await service.listPlugins()).toMatchObject([]);
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
    expect((await service.listPlugins()).map(({ id, status }) => ({ id, status }))).toEqual([
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
    expect(await service.listPlugins()).toMatchObject([
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
    const legacy = await createPlugin("legacy-plugin", "export default () => () => {};");
    await rm(path.join(legacy, "index.server.ts"));
    await writeFile(path.join(legacy, "index.ts"), "export default () => () => {};");
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
    await expect(service.installDirectory({ path: legacy })).rejects.toThrow(
      "This plugin was made for an older version of Paseo and cannot run on Paseo v0.8. Ask its author to update it. Plugin authors can follow the migration guide: https://paseo.sh/docs/plugins/migration",
    );
    await expect(service.installDirectory({ path: startupFailure })).rejects.toThrow(
      "startup exploded",
    );
    expect(await service.listPlugins()).toMatchObject([
      expect.objectContaining({
        id: "legacy-plugin",
        status: "failed",
        error:
          "This plugin was made for an older version of Paseo and cannot run on Paseo v0.8. Ask its author to update it. Plugin authors can follow the migration guide: https://paseo.sh/docs/plugins/migration",
      }),
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

describe("npm plugin installation", () => {
  it("preserves dependencies and metadata, and reloads without npm", async () => {
    const packages = npmPluginPackages();
    const fixture = packages[1];
    packages.push({ ...fixture, version: "2.0.0", tags: ["future"] });
    const failures: Array<[string, Record<string, string>]> = [
      ["bad-manifest", { "paseo-plugin.json": "{}" }],
      [
        "bad-build",
        {
          "paseo-plugin.json": JSON.stringify({
            id: "bad-build",
            requirements: { paseo: ">=0.4.0" },
            build: [[process.execPath, "-e", "throw new Error('preparation failed')"]],
          }),
        },
      ],
      [
        "bad-requirements",
        {
          "paseo-plugin.json": JSON.stringify({
            id: "bad-requirements",
            requirements: { paseo: ">=999.0.0" },
          }),
        },
      ],
      ["bad-code", { "index.server.ts": "invalid syntax !!!" }],
      [
        "bad-activation",
        { "index.server.ts": "export default () => { throw new Error('activation failed'); };" },
      ],
    ];
    const failedPackages = [];
    for (const [name, overrides] of failures) {
      failedPackages.push({ ...fixture, name, files: { ...fixture.files, ...overrides } });
    }
    const registry = await startNpmRegistry([
      ...packages,
      {
        name: "paseo-prepared-plugin",
        version: "1.0.0",
        dependencies: { "paseo-fixture-dependency": "1.0.0" },
        scripts: { postinstall: "node -e \"throw new Error('npm lifecycle must not run')\"" },
        files: {
          "nested/paseo-plugin.json": JSON.stringify({
            id: "prepared",
            requirements: { paseo: ">=0.4.0" },
            build: [
              [
                process.execPath,
                "-e",
                "require('node:fs').mkdirSync('server'); require('node:fs').writeFileSync('server/generated.js', 'export default 42;');",
              ],
            ],
          }),
          "nested/index.server.ts": `import generated from "./server/generated.js";
import dependency from "paseo-fixture-dependency";
import { z } from "zod";
export default function contribute() {
  if (generated !== 42 || z.string().parse(dependency) !== "dependency loaded") throw new Error("Preparation failed");
  return () => {};
}`,
        },
      },
      ...failedPackages,
    ]);
    const home = await mkdtemp(path.join(tmpdir(), "paseo-npm-service-"));
    roots.push(home);
    const previousConfig = process.env.npm_config_userconfig;
    const previousPath = process.env.PATH;
    process.env.npm_config_userconfig = registry.userconfig;
    const store = createStore(home);
    const open = () =>
      bindTestSessionHost(
        new PluginService(pino({ level: "silent" }), store, "0.8.0", {
          managedSources: new ManagedPluginSources(home),
        }),
      );
    let service = open();
    try {
      await service.start();
      const installed = await service.installSource({ source: "npm:paseo-fixture-plugin@^1.0.0" });
      expect(installed).toMatchObject({
        id: "npm-review",
        status: "running",
        installation: {
          identity: { kind: "npm", packageName: "paseo-fixture-plugin", pluginPath: "." },
          currentRevision: "1.1.0",
        },
      });
      expect(installed.commit).toBeUndefined();
      expect(installed.remote).toBeUndefined();
      expect(
        service
          .getLogs("npm-review")
          .map((entry) => entry.message)
          .join("\n"),
      ).toContain("dependency loaded");
      const installRoot = path.dirname(path.dirname(installed.path));
      expect(
        JSON.parse(await readFile(path.join(home, "plugins", "sources.json"), "utf8"))[
          "npm-review"
        ],
      ).toEqual({ kind: "npm" });
      expect(
        JSON.parse(await readFile(path.join(installRoot, "package-lock.json"), "utf8")).packages[
          "node_modules/paseo-fixture-dependency"
        ].version,
      ).toBe("1.0.0");
      for (const [source, id, version] of [
        ["npm:paseo-fixture-plugin@1.0.0", "exact", "1.0.0"],
        ["paseo-fixture-plugin@stable", "tag", "1.0.0"],
        ["npm:@paseo-fixture/review", "scoped", "2.0.0"],
      ]) {
        expect(await service.installSource({ source, id })).toMatchObject({
          id,
          status: "running",
          installation: { currentRevision: version },
        });
      }
      const [preview] = await service.previewUpdates({ pluginId: "exact" });
      expect(preview).toMatchObject({
        outcome: "update",
        current: { currentRevision: "1.0.0" },
        target: { version: "1.1.0" },
      });
      const before = (await service.listPlugins()).find((item) => item.id === "exact")!;
      await service.disablePlugin("exact");
      registry.setTag("paseo-fixture-plugin", "latest", "2.0.0");
      const results = await service.applyUpdates([
        { ...preview!.proposal!, id: "missing-plugin" },
        preview!.proposal!,
      ]);
      expect(results).toMatchObject([
        { outcome: "error" },
        {
          outcome: "updated",
          plugin: { enabled: false, installation: { currentRevision: "1.1.0" } },
        },
      ]);
      expect(results[1]?.plugin?.installation?.identity).toEqual(before.installation?.identity);
      registry.setTag("paseo-fixture-plugin", "latest", "1.1.0");
      expect(await service.applyUpdates([preview!.proposal!])).toMatchObject([
        { outcome: "error", error: expect.stringContaining("changed since review") },
      ]);
      await service.enablePlugin("exact");
      const [future] = await service.previewUpdates({
        pluginId: "exact",
        target: { kind: "npm", version: "future" },
      });
      expect(await service.applyUpdates([future!.proposal!])).toMatchObject([
        { outcome: "updated", plugin: { installation: { currentRevision: "2.0.0" } } },
      ]);
      const [newer] = await service.previewUpdates({ pluginId: "exact" });
      expect(newer).toMatchObject({
        outcome: "installed-newer",
        current: { currentRevision: "2.0.0" },
        target: { version: "1.1.0" },
      });
      expect(newer?.proposal).toBeUndefined();
      const [downgrade] = await service.previewUpdates({
        pluginId: "exact",
        target: { kind: "npm", version: "1.0.0" },
      });
      const wrongArtifact = {
        ...downgrade!.proposal!,
        target: { ...downgrade!.proposal!.target, integrity: "sha512-invalid" },
      };
      expect(await service.applyUpdates([wrongArtifact])).toMatchObject([{ outcome: "error" }]);
      expect(await service.applyUpdates([downgrade!.proposal!])).toMatchObject([
        { outcome: "updated", plugin: { installation: { currentRevision: "1.0.0" } } },
      ]);
      expect((await service.previewUpdates({ pluginId: "exact" }))[0]?.outcome).toBe("update");
      await expect(service.updateSources("exact")).rejects.toThrow("Update the client");
      const prepared = await service.installSource({
        source: "npm:paseo-prepared-plugin@1.0.0:nested",
      });
      expect(prepared).toMatchObject({ id: "prepared", status: "running" });
      expect(await readFile(path.join(prepared.path, "server/generated.js"), "utf8")).toBe(
        "export default 42;",
      );
      expect(prepared.installation).toMatchObject({ identity: { pluginPath: "nested" } });
      await service.removePlugin("prepared");
      expect(registry.requests).not.toContain("/@getpaseo/plugin");
      await expect(service.installSource({ source: "npm:missing-plugin" })).rejects.toThrow();
      await expect(
        service.installSource({ source: "npm:paseo-fixture-plugin", ref: "main" }),
      ).rejects.toThrow("--ref is only valid for Git");
      await expect(service.installSource({ source: "npm:paseo-fixture-plugin" })).rejects.toThrow(
        "already configured",
      );
      expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      for (const name of [
        "bad-manifest",
        "bad-build",
        "bad-requirements",
        "bad-code",
        "bad-activation",
      ]) {
        await expect(service.installSource({ source: `npm:${name}`, id: name })).rejects.toThrow();
        expect((await service.listPlugins()).map((plugin) => plugin.id)).toEqual([
          "exact",
          "npm-review",
          "scoped",
          "tag",
        ]);
        expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      }
      await service.disablePlugin("scoped");
      await service.stopAllPlugins();
      const recordsPath = path.join(home, "plugins", "sources.json");
      const oldRecords = JSON.parse(await readFile(recordsPath, "utf8"));
      Object.assign(oldRecords["npm-review"], {
        requestedSpec: "0.0.1",
        version: "0.0.1",
        packageName: "obsolete",
        installRoot: "/obsolete",
        integrity: "obsolete",
      });
      await writeFile(recordsPath, JSON.stringify(oldRecords));
      process.env.PATH = path.join(home, "no-executables");
      service = open();
      await service.start();
      expect(await service.listPlugins()).toMatchObject(
        expect.arrayContaining([
          expect.objectContaining({
            id: "npm-review",
            status: "running",
            installation: installed.installation,
          }),
          expect.objectContaining({ id: "scoped", enabled: false, status: "disabled" }),
        ]),
      );
      expect(await service.reloadPlugin("npm-review")).toMatchObject({
        status: "running",
        installation: installed.installation,
      });
      await expect(
        service.installSource({ source: "npm:paseo-fixture-plugin", id: "missing-npm" }),
      ).rejects.toThrow("npm is required on the daemon host");
      expect(await readdir(path.join(home, "plugins", ".staging"))).toEqual([]);
      const packagePath = path.join(installed.path, "package.json");
      const packageJson = await readFile(packagePath, "utf8");
      await writeFile(
        packagePath,
        JSON.stringify({ ...JSON.parse(packageJson), version: "99.0.0" }),
      );
      const corrupt = (await service.listPlugins()).find((plugin) => plugin.id === "npm-review")!;
      expect(corrupt.status).toBe("running");
      expect(corrupt.installation).toEqual({ identity: installed.installation!.identity });
      expect((await service.previewUpdates({ pluginId: "npm-review" }))[0]).toMatchObject({
        outcome: "error",
        error: expect.stringContaining("Installed revision is unavailable"),
      });
      expect(await service.reloadPlugin("npm-review")).toMatchObject({ status: "running" });
      await writeFile(packagePath, packageJson);
      await service.removePlugin("npm-review");
      await expect(stat(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        JSON.parse(await readFile(path.join(home, "plugins", "sources.json"), "utf8"))[
          "npm-review"
        ],
      ).toBeUndefined();
    } finally {
      process.env.PATH = previousPath;
      if (previousConfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = previousConfig;
      await service.stopAllPlugins();
      await registry.close();
    }
  }, 120_000);
});

async function applyReviewedUpdate(service: PluginService, pluginId: string) {
  const [preview] = await service.previewUpdates({ pluginId });
  expect(preview?.outcome).toBe("update");
  return service.applyUpdates([preview!.proposal!]);
}
