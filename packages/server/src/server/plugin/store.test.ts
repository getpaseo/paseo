import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PluginStateFileSchema } from "@getpaseo/protocol/plugin/types";
import { PluginPathTraversalError, PluginStore } from "./store.js";

const DAEMON_VERSION = "0.2.6";

interface WritePluginOptions {
  manifest?: unknown;
  manifestRaw?: string;
  files?: Record<string, string>;
}

describe("PluginStore", () => {
  let tempDir: string;
  let store: PluginStore;

  async function writePlugin(pluginId: string, options: WritePluginOptions = {}): Promise<void> {
    const dir = join(tempDir, pluginId);
    await mkdir(dir, { recursive: true });
    const manifest = options.manifest ?? {
      id: pluginId,
      name: "CSV Table",
      version: "1.0.0",
      paseoVersion: ">=0.2.0",
      contributes: {
        filePreviews: [
          { id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" },
        ],
      },
    };
    await writeFile(
      join(dir, "paseo-plugin.json"),
      options.manifestRaw ?? JSON.stringify(manifest, null, 2),
    );
    const files = options.files ?? { "preview.html": "<h1>table</h1>" };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "plugin-store-test-"));
    store = new PluginStore({ dir: tempDir, daemonVersion: DAEMON_VERSION });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("discovers a hand-dropped plugin as enabled and locally sourced", async () => {
    await writePlugin("csv-table");

    const plugins = await store.list();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      manifest: { id: "csv-table", name: "CSV Table", version: "1.0.0" },
      enabled: true,
      source: { kind: "local" },
      unavailableReason: null,
    });
  });

  test("keeps installedAt stable across repeated listings", async () => {
    await writePlugin("csv-table");

    const first = await store.list();
    const second = await store.list();

    expect(second[0]?.installedAt).toBe(first[0]?.installedAt);
  });

  test("ignores directories whose name is not a plugin id", async () => {
    await mkdir(join(tempDir, "Not A Plugin"), { recursive: true });
    await writeFile(join(tempDir, "Not A Plugin", "paseo-plugin.json"), "{}");

    expect(await store.list()).toEqual([]);
  });

  test("reports a manifest that does not parse instead of dropping the plugin", async () => {
    await writePlugin("broken-json", { manifestRaw: "{ this is not json" });

    const plugins = await store.list();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.id).toBe("broken-json");
    expect(plugins[0]?.unavailableReason).toContain("Manifest is invalid");
  });

  test("reports a manifest id that disagrees with its directory", async () => {
    await writePlugin("csv-table", {
      manifest: {
        id: "other-id",
        name: "CSV Table",
        version: "1.0.0",
        contributes: {
          filePreviews: [
            { id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" },
          ],
        },
      },
    });

    const plugins = await store.list();

    expect(plugins[0]?.manifest.id).toBe("csv-table");
    expect(plugins[0]?.unavailableReason).toBe(
      'Manifest id "other-id" does not match directory "csv-table"',
    );
  });

  test("reports an unsatisfied paseoVersion range", async () => {
    await writePlugin("future-plugin", {
      manifest: {
        id: "future-plugin",
        name: "Future",
        version: "1.0.0",
        paseoVersion: ">=9.0.0",
        contributes: {
          sidebarPanels: [{ id: "panel", title: "Panel", entry: "panel.html" }],
        },
      },
      files: { "panel.html": "<p>hi</p>" },
    });

    const plugins = await store.list();

    expect(plugins[0]?.unavailableReason).toBe("Requires Paseo >=9.0.0, this daemon is 0.2.6");
  });

  test("reports a contribution whose entry file is missing", async () => {
    await writePlugin("no-entry", { files: {} });

    const plugins = await store.list();

    expect(plugins[0]?.unavailableReason).toBe('Missing entry file "preview.html"');
  });

  test("reads a contribution's HTML", async () => {
    await writePlugin("csv-table", { files: { "preview.html": "<h1>table</h1>" } });

    expect(await store.readEntry("csv-table", "preview.html")).toBe("<h1>table</h1>");
  });

  test("refuses to read outside the plugin directory", async () => {
    await writePlugin("csv-table");
    await writeFile(join(tempDir, "secret.html"), "<p>secret</p>");

    await expect(store.readEntry("csv-table", "../secret.html")).rejects.toBeInstanceOf(
      PluginPathTraversalError,
    );
    await expect(store.readEntry("csv-table", "../../etc/passwd.html")).rejects.toBeInstanceOf(
      PluginPathTraversalError,
    );
    await expect(store.readEntry("../csv-table", "preview.html")).rejects.toBeInstanceOf(
      PluginPathTraversalError,
    );
    await expect(store.readEntry("csv-table", "sub/preview.html")).rejects.toBeInstanceOf(
      PluginPathTraversalError,
    );
  });

  test("round-trips enabled state through installed.json", async () => {
    await writePlugin("csv-table");
    await store.list();

    await store.setEnabled("csv-table", false);

    const persisted = PluginStateFileSchema.parse(
      JSON.parse(await readFile(join(tempDir, "installed.json"), "utf-8")),
    );
    expect(persisted.plugins).toEqual([
      expect.objectContaining({ id: "csv-table", enabled: false }),
    ]);

    const reloaded = new PluginStore({ dir: tempDir, daemonVersion: DAEMON_VERSION });
    expect((await reloaded.list())[0]?.enabled).toBe(false);

    await reloaded.setEnabled("csv-table", true);
    expect((await reloaded.list())[0]?.enabled).toBe(true);
  });

  test("uninstall removes the directory and the state entry", async () => {
    await writePlugin("csv-table");
    await store.list();

    await store.uninstall("csv-table");

    expect(await store.list()).toEqual([]);
    const persisted = PluginStateFileSchema.parse(
      JSON.parse(await readFile(join(tempDir, "installed.json"), "utf-8")),
    );
    expect(persisted.plugins).toEqual([]);
  });
});
