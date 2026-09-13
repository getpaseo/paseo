import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { settingsRpc } from "@getpaseo/plugin";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("a plugin server can persist workflow state through its registered settings handle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-settings-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "workflow-settings", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
      import { defineSettings, defineRpc } from "@getpaseo/plugin";
      import { z } from "zod";
      export default function(server) {
        const state = server.registerSettings(defineSettings({ id: "workflow", scope: "host", version: 1, schema: z.object({ count: z.number().default(0) }) }));
        server.handle(defineRpc({ name: "workflow.increment.request", input: z.object({}), output: z.number() }), async () => {
          if (!state) return -1;
          const current = await state.read();
          await state.write({ count: current.values.count + 1 }, current.revision);
          return (await state.read()).values.count;
        });
        return () => {};
      }
    `,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    expect(
      await client.invokePluginRpc("workflow-settings", "workflow.increment.request", {}),
    ).toBe(1);
    await client.reloadPlugin("workflow-settings");
    expect(
      await client.invokePluginRpc("workflow-settings", "workflow.increment.request", {}),
    ).toBe(2);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("two clients share settings, observe changes, and preserve values through plugin lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "settings-plugin-"));
  const daemon = await createTestPaseoDaemon();
  const first = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const rpc = settingsRpc("display");
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
      `import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export default function(server) { server.registerSettings(defineSettings({ id: "display", scope: "host", version: 1, schema: z.object({ enabled: z.boolean().default(true) }) })); return () => {}; }`,
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
      await second.invokePluginRpc("settings-test", rpc.write.name, {
        revision: initial.revision,
        values: { enabled: false },
      }),
    ).toMatchObject({ status: "saved" });
    await expect.poll(() => changed).toEqual(["display"]);
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
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
