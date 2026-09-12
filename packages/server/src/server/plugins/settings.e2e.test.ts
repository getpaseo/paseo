import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { defineRpc, settingsRpc } from "@getpaseo/plugin";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

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
