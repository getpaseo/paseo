import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
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
    `import { defineRpc, type PluginServerContext } from "@getpaseo/plugin";
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

  async function setPluginsEnabled(enabled: boolean): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, pluginsEnabled: enabled }, null, 2)}\n`,
    );
  }

  try {
    await client.connect();
    await expect(client.listPlugins()).resolves.toEqual([
      expect.objectContaining({ id: "reloadable-plugin", status: "disabled" }),
    ]);

    await setPluginsEnabled(true);
    await expect(client.reloadDaemonConfig()).resolves.toMatchObject({
      requestId: expect.any(String),
      appliedPaths: expect.arrayContaining(["pluginsEnabled"]),
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await expect
      .poll(async () => (await client.listPlugins()).find(({ id }) => id === "reloadable-plugin"))
      .toMatchObject({ enabled: true, status: "running" });

    await setPluginsEnabled(false);
    await expect(client.reloadDaemonConfig()).resolves.toEqual({
      requestId: expect.any(String),
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await expect
      .poll(async () => (await client.listPlugins()).find(({ id }) => id === "reloadable-plugin"))
      .toMatchObject({ enabled: true, status: "disabled" });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);
