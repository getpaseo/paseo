import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { InstalledPlugin, PluginRegistryIndex } from "@getpaseo/protocol/plugin/types";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const PREVIEW_HTML = "<!doctype html><h1>csv table</h1>";

/**
 * Drives the plugins.* RPCs against a real daemon whose registry is a local
 * `file://` index — the same path `daemon.plugins.registryUrl` takes when a
 * plugin author develops against a local marketplace.
 */
describe("plugins RPCs", () => {
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), "paseo-plugin-registry-"));
    const previewPath = join(registryDir, "preview.html");
    await writeFile(previewPath, PREVIEW_HTML);
    const index: PluginRegistryIndex = {
      version: 1,
      plugins: [
        {
          manifest: {
            id: "csv-table",
            name: "CSV Table",
            version: "1.0.0",
            description: "Render CSV files as a table.",
            contributes: {
              filePreviews: [
                { id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" },
              ],
            },
          },
          files: [
            {
              name: "preview.html",
              url: pathToFileURL(previewPath).href,
              sha256: createHash("sha256").update(PREVIEW_HTML).digest("hex"),
              bytes: Buffer.byteLength(PREVIEW_HTML),
            },
          ],
        },
      ],
    };
    const indexPath = join(registryDir, "index.json");
    await writeFile(indexPath, JSON.stringify(index));

    daemon = await createTestPaseoDaemon({
      plugins: { registryUrl: pathToFileURL(indexPath).href },
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      messageQueueLimit: null,
    });
    await client.connect();
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close();
    await rm(registryDir, { recursive: true, force: true });
  }, 30_000);

  test("lists, installs, reads, disables, and uninstalls a registry plugin", async () => {
    const empty = await client.pluginsList();
    expect(empty.error).toBeNull();
    expect(empty.plugins).toEqual([]);

    const browsed = await client.pluginsBrowse();
    expect(browsed.error).toBeNull();
    expect(browsed.plugins.map((entry) => entry.manifest.id)).toEqual(["csv-table"]);

    const installed = await client.pluginsInstall({ pluginId: "csv-table" });
    expect(installed.error).toBeNull();
    expect(installed.plugin).toMatchObject({
      manifest: { id: "csv-table", name: "CSV Table" },
      enabled: true,
      unavailableReason: null,
    });

    const listed = await client.pluginsList();
    expect(listed.plugins.map((plugin) => plugin.manifest.id)).toEqual(["csv-table"]);

    const entry = await client.pluginsGetEntry({ pluginId: "csv-table", entry: "preview.html" });
    expect(entry.error).toBeNull();
    expect(entry.html).toBe(PREVIEW_HTML);

    const disabled = await client.pluginsSetEnabled({ pluginId: "csv-table", enabled: false });
    expect(disabled.error).toBeNull();
    expect(disabled.plugin?.enabled).toBe(false);
    expect((await client.pluginsList()).plugins[0]?.enabled).toBe(false);

    const uninstalled = await client.pluginsUninstall({ pluginId: "csv-table" });
    expect(uninstalled.error).toBeNull();
    expect((await client.pluginsList()).plugins).toEqual([]);
  }, 30_000);

  test("answers a bad entry with an error instead of dropping the session", async () => {
    await client.pluginsInstall({ pluginId: "csv-table" });

    const missing = await client.pluginsGetEntry({ pluginId: "csv-table", entry: "nope.html" });
    expect(missing.html).toBeNull();
    expect(missing.error).toContain("nope.html");

    const failedInstall = await client.pluginsInstall({ pluginId: "not-published" });
    expect(failedInstall.plugin).toBeNull();
    expect(failedInstall.error).toContain("not-published");

    // The session survived both failures.
    expect((await client.pluginsList()).plugins.map((plugin) => plugin.manifest.id)).toEqual([
      "csv-table",
    ]);
  }, 30_000);

  test("advertises the plugins capability and broadcasts changes to other sessions", async () => {
    const observer = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      messageQueueLimit: null,
    });
    await observer.connect();
    try {
      expect(observer.getLastServerInfoMessage()?.features?.plugins).toBe(true);

      const changed = new Promise<InstalledPlugin[]>((resolve) => {
        observer.on("plugins.changed", (message) => resolve(message.payload.plugins));
      });

      await client.pluginsInstall({ pluginId: "csv-table" });

      expect((await changed).map((plugin) => plugin.manifest.id)).toEqual(["csv-table"]);
    } finally {
      await observer.close().catch(() => undefined);
    }
  }, 30_000);
});
