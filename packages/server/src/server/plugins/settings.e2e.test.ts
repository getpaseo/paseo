import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { defineRpc, settingsRpc } from "@getpaseo/plugin";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("server reads saved settings after daemon restart before any client connects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "settings-restart-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "plugin");
  const startupReport = path.join(root, "startup.json");
  await mkdir(path.join(directory, "server"), { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "settings-startup",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "server", "report.ts"),
    `import { writeFile } from "node:fs/promises";
export async function reportStartup(settings) {
  const state = await settings.read();
  await writeFile(${JSON.stringify(startupReport)}, JSON.stringify(state));
}`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { reportStartup } from "./server/report";
export default function(server) {
  const settings = server.registerSettings(defineSettings({ id: "display", scope: "host", version: 1, schema: z.object({ enabled: z.boolean().default(true) }) }));
  const startup = reportStartup(settings);
  return async () => { await startup; };
}`,
  );
  const options = {
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "settings-startup": { source: "directory" as const, path: directory, enabled: true },
    },
  };
  const first = await createTestPaseoDaemon(options);
  onTestFinished(() => first.close());
  const rpc = settingsRpc("display");
  const readStartup = async () =>
    rpc.read.output.parse(JSON.parse(await readFile(startupReport, "utf8")));
  await expect
    .poll(readStartup)
    .toEqual({ status: "ready", revision: "missing", values: { enabled: true } });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.8.0" });
  onTestFinished(() => client.close());
  await client.connect();
  const saved = rpc.write.output.parse(
    await client.invokePluginRpc("settings-startup", rpc.write.name, {
      revision: "missing",
      values: { enabled: false },
    }),
  );
  expect(saved).toMatchObject({ status: "saved", values: { enabled: false } });
  const persisted = rpc.read.output.parse(
    await client.invokePluginRpc("settings-startup", rpc.read.name, {}),
  );
  await client.close();
  await first.close();
  await rm(startupReport);

  const restarted = await createTestPaseoDaemon(options);
  onTestFinished(() => restarted.close());
  // No client is created for this daemon: the report comes from server startup alone.
  await expect.poll(readStartup).toEqual(persisted);
}, 60_000);

test("two clients share settings, observe changes, and preserve values through plugin lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "settings-plugin-"));
  const daemon = await createTestPaseoDaemon();
  const first = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const rpc = settingsRpc("display");
  const serverReadRpc = defineRpc({
    name: "settings-test.server-read",
    input: z.object({}),
    output: z.json(),
  });
  const serverChangesRpc = defineRpc({
    name: "settings-test.server-changes",
    input: z.object({}),
    output: z.object({ count: z.number().int() }),
  });
  const read = async (client: DaemonClient, pluginId = "settings-test") =>
    rpc.read.output.parse(await client.invokePluginRpc(pluginId, rpc.read.name, {}));
  const changed: string[] = [];
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "settings-test",
        requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
const serverRead = defineRpc({ name: "settings-test.server-read", input: z.object({}), output: z.json() });
const serverChanges = defineRpc({ name: "settings-test.server-changes", input: z.object({}), output: z.object({ count: z.number().int() }) });
export default function(server) {
  const settings = server.registerSettings(defineSettings({ id: "display", scope: "host", version: 1, schema: z.object({ enabled: z.boolean().default(true) }) }));
  let changes = 0;
  settings.subscribe(() => { changes += 1; });
  server.handle(serverRead, () => settings.read());
  server.handle(serverChanges, () => ({ count: changes }));
  return () => {};
}`,
    );
    await first.connect();
    await second.connect();
    await second.observeEvents(["status.plugin_settings_changed"]).ready;
    second.on("status", (message) => {
      if (message.payload.status === "plugin_settings_changed")
        changed.push(z.string().parse(message.payload.settingsId));
    });
    await first.patchDaemonConfig({ pluginsEnabled: true });
    await first.installDirectoryPlugin(directory);
    const initial = await read(first);
    expect(initial).toMatchObject({ status: "ready", values: { enabled: true } });
    expect(
      serverReadRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverReadRpc.name, {}),
      ),
    ).toMatchObject({ status: "ready", values: { enabled: true } });
    expect(
      serverChangesRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverChangesRpc.name, {}),
      ),
    ).toEqual({ count: 0 });
    expect(
      await second.invokePluginRpc("settings-test", rpc.write.name, {
        revision: initial.revision,
        values: { enabled: false },
      }),
    ).toMatchObject({ status: "saved" });
    await expect.poll(() => changed).toEqual(["display"]);
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
    expect(
      serverReadRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverReadRpc.name, {}),
      ),
    ).toMatchObject({ status: "ready", values: { enabled: false } });
    expect(
      serverChangesRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverChangesRpc.name, {}),
      ),
    ).toEqual({ count: 1 });
    expect(
      await first.invokePluginRpc("settings-test", rpc.write.name, {
        revision: initial.revision,
        values: { enabled: true },
      }),
    ).toMatchObject({ status: "conflict" });
    await first.reloadPlugin("settings-test");
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
    await first.disablePlugin("settings-test");
    await first.enablePlugin("settings-test");
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
    await first.installDirectoryPlugin(directory, "other-installation");
    expect(await read(first, "other-installation")).toMatchObject({ values: { enabled: true } });
    await first.removePlugin("settings-test");
    await first.installDirectoryPlugin(directory);
    expect(await read(first)).toMatchObject({ values: { enabled: true } });
  } catch (error) {
    console.error(await first.getPluginLogs("settings-test"));
    throw error;
  } finally {
    await first.close();
    await second.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("server settings document is shared by startup, RPC, lifecycle, and client reads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "server-settings-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "server-settings-workspace-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
  });
  const rpc = settingsRpc("state");
  const read = async () =>
    rpc.read.output.parse(await client.invokePluginRpc("server-settings", rpc.read.name, {}));
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "server-settings",
        requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
const state = defineSettings({ id: "state", scope: "host", version: 1, schema: z.object({ count: z.number().int().default(0) }) });
const bump = defineRpc({ name: "bump", input: z.object({}), output: z.object({ count: z.number() }) });
const create = defineRpc({ name: "create", input: z.object({ path: z.string() }), output: z.object({ agentId: z.string() }) });
export default function contribute(server) {
  const document = server.registerSettings(state);
  void document.update((current) => ({ status: "commit", values: { count: current.count + 1 }, result: null }));
  server.handle(bump, async () => {
    const result = await document.update((current) => ({ status: "commit", values: { count: current.count + 1 }, result: null }));
    if (result.status === "invalid") throw new Error(result.code);
    return { count: result.values.count };
  });
  server.handle(create, async ({ path }) => {
    const workspace = await server.paseo.workspaces.create({ source: { kind: "directory", path } });
    const agent = await workspace.agents.create({ config: { provider: "pi/test" }, prompt: "settings lifecycle" });
    return { agentId: agent.id };
  });
  const off = server.on("agent.created", () => document.update((current) => ({ status: "commit", values: { count: current.count + 1 }, result: null })));
  return off;
}`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await expect.poll(async () => read()).toMatchObject({ status: "ready", values: { count: 1 } });
    await expect(client.invokePluginRpc("server-settings", "bump", {})).resolves.toEqual({
      count: 2,
    });
    await client.invokePluginRpc("server-settings", "create", { path: workspaceDirectory });
    await expect.poll(async () => read()).toMatchObject({ status: "ready", values: { count: 3 } });
  } catch (error) {
    console.error(await client.getPluginLogs("server-settings"));
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
}, 60_000);
