import { EventEmitter, once } from "node:events";
import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("plugin handlers create workspaces and agents through their Paseo API", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "paseo-api",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const create = defineRpc({
  name: "create",
  input: z.object({ path: z.string() }),
  output: z.object({ workspaceId: z.string(), agentId: z.string() }),
});

const list = defineRpc({
  name: "list",
  input: z.object({}),
  output: z.object({ agentIds: z.array(z.string()) }),
});

const append = defineRpc({
  name: "append",
  input: z.object({ agentId: z.string(), status: z.string() }),
  output: z.object({ seq: z.number(), epoch: z.string() }),
});

export default function contribute(server: PluginServerContext) {
  server.handle(create, async ({ path }, { paseo }) => {
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path },
      title: "Plugin workspace",
    });
    const agent = await workspace.agents.create({
      config: { provider: "pi/test" },
      prompt: "Created by a plugin handler",
    });
    return { workspaceId: workspace.id, agentId: agent.id };
  });
  server.handle(list, async (_input, { paseo }) => {
    const result = await paseo.agents.list({ page: { limit: 100 } });
    return { agentIds: result.entries.map((entry) => entry.agent.id) };
  });
  server.handle(append, ({ agentId, status }, { paseo }) =>
    paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: "review-1",
      kind: "review",
      version: 1,
      data: { status },
    }),
  );
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
      id: "paseo-api",
      status: "running",
    });

    const created = await client.invokePluginRpc("paseo-api", "create", {
      path: workspaceDirectory,
    });

    expect(created).toEqual({
      workspaceId: expect.stringMatching(/^wks_/),
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    if (typeof created !== "object" || created === null) {
      throw new Error("Plugin returned an invalid creation result");
    }
    const listed = await client.invokePluginRpc("paseo-api", "list", {});
    expect(listed).toEqual({
      agentIds: expect.arrayContaining([Reflect.get(created, "agentId")]),
    });
    const agentId = Reflect.get(created, "agentId");
    await expect(
      client.invokePluginRpc("paseo-api", "append", { agentId, status: "running" }),
    ).resolves.toEqual({ seq: expect.any(Number), epoch: expect.any(String) });
    await client.invokePluginRpc("paseo-api", "append", { agentId, status: "complete" });
    const timeline = await client.fetchAgentTimeline(agentId, { projection: "projected" });
    expect(timeline.entries.filter((entry) => entry.item.type === "plugin")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          type: "plugin",
          id: "review-1",
          pluginId: "paseo-api",
          data: { status: "complete" },
        }),
      }),
    ]);
    await client.removePlugin("paseo-api");
    const workspaces = await client.fetchWorkspaces();
    const agents = await client.fetchAgents();
    expect(workspaces.entries.map((workspace) => workspace.id)).toContain(
      Reflect.get(created, "workspaceId"),
    );
    expect(agents.entries.map((entry) => entry.agent.id)).toContain(
      Reflect.get(created, "agentId"),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("plugins read client presence from app heartbeats", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-presence-plugin-"));
  roots.push(pluginDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "presence",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const read = defineRpc({ name: "read", input: z.object({}), output: z.unknown() });

export default function contribute(server: PluginServerContext) {
  server.handle(read, () => server.presence());
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  const readPresence = () => client.invokePluginRpc("presence", "read", {});
  // Heartbeats are fire-and-forget, so read until the daemon has applied the latest one.
  async function waitForPresence(expected: unknown): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const presence = await readPresence();
      if (JSON.stringify(presence) === JSON.stringify(expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readPresence()).toEqual(expected);
  }

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);

    await expect(readPresence()).resolves.toEqual({ userPresent: false, clients: [] });

    const activeAt = new Date().toISOString();
    client.sendHeartbeat({
      deviceType: "mobile",
      focusedAgentId: "agent-1",
      lastActivityAt: activeAt,
      appVisible: true,
    });
    await waitForPresence({
      userPresent: true,
      clients: [
        {
          deviceType: "mobile",
          appVisible: true,
          focusedAgentId: "agent-1",
          lastActivityAt: activeAt,
        },
      ],
    });

    const idleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    client.sendHeartbeat({
      deviceType: "mobile",
      focusedAgentId: null,
      lastActivityAt: idleAt,
      appVisible: false,
    });
    await waitForPresence({
      userPresent: false,
      clients: [
        { deviceType: "mobile", appVisible: false, focusedAgentId: null, lastActivityAt: idleAt },
      ],
    });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("daemon config reload enables and disables configured plugins without restarting", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reload-plugin-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-reload-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  roots.push(pluginDirectory, paseoHomeRoot);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "reloadable-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `export default function contribute(server: unknown) {
  void server;
  return () => undefined;
    }`,
  );

  const plugins = {
    "reloadable-plugin": { source: "directory" as const, path: pluginDirectory, enabled: true },
  };
  await mkdir(paseoHome, { recursive: true });
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({ version: 1, pluginsEnabled: false, plugins }, null, 2)}\n`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    pluginsEnabled: false,
    plugins,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  const configPath = path.join(daemon.paseoHome, "config.json");
  const catalogChanges = new EventEmitter();

  async function setPluginsEnabled(enabled: boolean): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, pluginsEnabled: enabled }, null, 2)}\n`,
    );
  }

  try {
    await client.connect();
    const catalog = client.observeEvents(["status.plugin_catalog_changed"]);
    catalog.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (
          message.type === "status" &&
          message.payload.status === "plugin_catalog_changed" &&
          message.payload.pluginId === "reloadable-plugin"
        ) {
          catalogChanges.emit("changed");
        }
      },
    });
    await catalog.ready;
    await expect(client.listPlugins()).resolves.toEqual([
      expect.objectContaining({ id: "reloadable-plugin", status: "disabled" }),
    ]);

    const enabled = once(catalogChanges, "changed");
    await setPluginsEnabled(true);
    await expect(client.reloadDaemonConfig()).resolves.toMatchObject({
      requestId: expect.any(String),
      appliedPaths: expect.arrayContaining(["pluginsEnabled"]),
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await enabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "running" },
    );

    const disabled = once(catalogChanges, "changed");

    await setPluginsEnabled(false);
    await expect(client.reloadDaemonConfig()).resolves.toEqual({
      requestId: expect.any(String),
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await disabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "disabled" },
    );
    await catalog.release();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

const ReconnectingPluginStateSchema = z.object({
  snapshots: z.array(z.string()),
  names: z.array(z.string()),
});

async function readReconnectingPluginState(client: DaemonClient) {
  return ReconnectingPluginStateSchema.parse(
    await client.invokePluginRpc("reconnecting", "state", {}),
  );
}

test("plugin host APIs and observations recover after repeated daemon-side socket closes", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "reconnecting", requirements: { paseo: ">=0.8.0" } }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

export default function contribute(server: PluginServerContext) {
  const snapshots: string[] = [];
  const names: string[] = [];
  const snapshotWaiters = new Map<number, (id: string) => void>();
  const nameWaiters = new Map<string, (name: string) => void>();
  let reconnected = Promise.resolve();
  let release: (() => Promise<void>) | undefined;
  server.handle(defineRpc({ name: "observe", input: z.object({}), output: z.string() }), async (_, { paseo }) => {
    const { subscription } = await paseo.workspaces.list({ subscribe: {} });
    subscription.subscribe({
      snapshot: (snapshot) => {
        const id = snapshot.subscriptionId!;
        snapshots.push(id);
        snapshotWaiters.get(snapshots.length)?.(id);
        snapshotWaiters.delete(snapshots.length);
      },
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") {
          const name = message.payload.workspace.name;
          names.push(name);
          nameWaiters.get(name)?.(name);
          nameWaiters.delete(name);
        }
      },
    });
    release = () => subscription.release();
    return subscription.subscriptionId!;
  });
  server.handle(defineRpc({ name: "wait-snapshot", input: z.object({ count: z.number().int().positive() }), output: z.string() }), ({ count }) => {
    const id = snapshots[count - 1];
    return id ?? new Promise<string>((resolve) => snapshotWaiters.set(count, resolve));
  });
  server.handle(defineRpc({ name: "wait-name", input: z.object({ name: z.string() }), output: z.string() }), ({ name }) => {
    return names.includes(name) ? name : new Promise<string>((resolve) => nameWaiters.set(name, resolve));
  });
  server.handle(defineRpc({ name: "state", input: z.object({}), output: z.object({ snapshots: z.array(z.string()), names: z.array(z.string()) }) }), () => ({ snapshots, names }));
  server.handle(defineRpc({ name: "probe", input: z.object({}), output: z.object({ pid: z.number(), projectIds: z.array(z.string()) }) }), async (_, { paseo }) => {
    await reconnected;
    return { pid: process.pid, projectIds: (await paseo.projects.list()).projects.map((project) => project.projectId) };
  });
  server.handle(defineRpc({ name: "release", input: z.object({}), output: z.null() }), async () => {
    await release?.();
    return null;
  });
  server.handle(defineRpc({ name: "disconnect", input: z.object({}), output: z.null() }), () => new Promise((resolve) => {
    // Inject a protocol violation through real IPC. The real daemon closes the
    // active socket, and the worker's normal transport must observe that close.
    function closed(message: { type: string }) {
      if (message.type !== "paseo_close") return;
      process.off("message", closed);
      resolve(null);
    }
    process.on("message", closed);
    reconnected = new Promise<void>((connected) => {
      function ready(message: { type: string; data?: unknown }) {
        if (message.type !== "paseo_frame" || typeof message.data !== "string") return;
        const frame = JSON.parse(message.data);
        if (frame.type !== "session" || frame.message.type !== "status" || frame.message.payload.status !== "server_info") return;
        process.off("message", ready);
        connected();
      }
      process.on("message", ready);
    });
    process.send!({ type: "paseo_frame", isBinary: false, data: JSON.stringify({
      type: "hello", clientId: "plugin:reconnecting", clientType: "cli", protocolVersion: 1,
    }) });
  }));
  return async () => { await release?.(); };
}`,
  );
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let projectId: string | undefined;
  try {
    await client.connect();
    const opened = await client.openProject(workspaceDirectory);
    if (!opened.workspace) throw new Error(opened.error ?? "Workspace did not open");
    projectId = opened.workspace.projectId;
    const workspaceId = opened.workspace.id;
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const original = await client.invokePluginRpc("reconnecting", "probe", {});
    expect(original).toEqual({ pid: expect.any(Number), projectIds: [projectId] });
    const initialId = await client.invokePluginRpc("reconnecting", "observe", {});
    const app = await client.fetchWorkspaces({ subscribe: {} });
    const appUpdates = new EventEmitter();
    app.subscription.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") {
          appUpdates.emit(message.payload.workspace.name);
        }
      },
    });
    await client.setWorkspaceTitle(workspaceId, "Before disconnect");
    await expect(
      client.invokePluginRpc("reconnecting", "wait-name", { name: "Before disconnect" }),
    ).resolves.toBe("Before disconnect");
    const ids = [initialId];
    for (const name of ["First recovery", "Second recovery"]) {
      await client.invokePluginRpc("reconnecting", "disconnect", {});
      const id = await client.invokePluginRpc("reconnecting", "wait-snapshot", {
        count: ids.length + 1,
      });
      ids.push(id);
      expect((await readReconnectingPluginState(client)).snapshots).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
      expect(app.subscription.subscriptionId).toBe(app.subscriptionId);
      const appUpdate = once(appUpdates, name);
      await client.setWorkspaceTitle(workspaceId, name);
      await expect(client.invokePluginRpc("reconnecting", "wait-name", { name })).resolves.toBe(
        name,
      );
      await appUpdate;
      expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    }
    await client.invokePluginRpc("reconnecting", "release", {});
    const releasedState = await client.invokePluginRpc("reconnecting", "state", {});
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    const appUpdateAfterRelease = once(appUpdates, "After release");
    await client.setWorkspaceTitle(workspaceId, "After release");
    await appUpdateAfterRelease;
    await client.invokePluginRpc("reconnecting", "probe", {});
    expect(await client.invokePluginRpc("reconnecting", "state", {})).toEqual(releasedState);
    await app.subscription.release();
    // Removal while reconnect is scheduled must stop the child, not reload it.
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    await client.removePlugin("reconnecting");
    expect(await client.listPlugins()).toEqual([]);
    await expect(client.invokePluginRpc("reconnecting", "probe", {})).rejects.toThrow(
      "Plugin is not available",
    );
  } finally {
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await daemon.close();
  }
}, 60_000);
