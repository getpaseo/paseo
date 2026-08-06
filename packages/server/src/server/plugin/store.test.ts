import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PluginStateFileSchema, type PluginManifest } from "@getpaseo/protocol/plugin/types";
import {
  PluginEntryNotFoundError,
  PluginEntryUnavailableError,
  PluginPathTraversalError,
  PluginStore,
} from "./store.js";

const DAEMON_VERSION = "0.2.6";
const REGISTRY_URL = "https://plugins.paseo.sh/index.json";

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function manifestFor(pluginId: string): PluginManifest {
  return {
    id: pluginId,
    name: "CSV Table",
    version: "1.0.0",
    contributes: {
      filePreviews: [{ id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" }],
    },
  };
}

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

  test("install writes the manifest and every file, and records the source", async () => {
    await store.install({
      pluginId: "csv-table",
      files: [{ name: "preview.html", bytes: encode("<h1>installed</h1>") }],
      manifest: manifestFor("csv-table"),
      source: { kind: "registry", registryUrl: REGISTRY_URL },
    });

    const plugins = await store.list();
    expect(plugins).toMatchObject([
      { manifest: { id: "csv-table" }, source: { kind: "registry" }, unavailableReason: null },
    ]);
    expect(await store.readEntry("csv-table", "preview.html")).toBe("<h1>installed</h1>");
    expect(await readdir(tempDir)).toEqual(["csv-table", "installed.json"]);
  });

  test("re-installing replaces the previous copy, files and all", async () => {
    await writePlugin("csv-table", { files: { "preview.html": "old", "stale.html": "old" } });
    await store.list();

    await store.install({
      pluginId: "csv-table",
      files: [{ name: "preview.html", bytes: encode("new") }],
      manifest: manifestFor("csv-table"),
      source: { kind: "registry", registryUrl: REGISTRY_URL },
    });

    expect(await readdir(join(tempDir, "csv-table"))).toEqual([
      "paseo-plugin.json",
      "preview.html",
    ]);
    expect(await store.readEntry("csv-table", "preview.html")).toBe("new");
  });

  test("a failed install leaves the previously installed copy intact", async () => {
    await writePlugin("csv-table", { files: { "preview.html": "old" } });
    await store.list();

    await expect(
      store.install({
        pluginId: "csv-table",
        // Rejected by PluginEntrySchema after the manifest is already staged.
        files: [{ name: "../escape.html", bytes: encode("evil") }],
        manifest: manifestFor("csv-table"),
        source: { kind: "registry", registryUrl: REGISTRY_URL },
      }),
    ).rejects.toThrow();

    expect(await store.readEntry("csv-table", "preview.html")).toBe("old");
    expect(await readdir(tempDir)).toEqual(["csv-table", "installed.json"]);
  });

  test("concurrent installs of one id do not interleave", async () => {
    const install = (body: string): Promise<void> =>
      store.install({
        pluginId: "csv-table",
        files: [{ name: "preview.html", bytes: encode(body) }],
        manifest: manifestFor("csv-table"),
        source: { kind: "registry", registryUrl: REGISTRY_URL },
      });

    await Promise.all([install("first"), install("second")]);

    expect(await store.readEntry("csv-table", "preview.html")).toBe("second");
    expect(await readdir(tempDir)).toEqual(["csv-table", "installed.json"]);
    expect(await store.list()).toHaveLength(1);
  });

  test("an uninstall queued behind an install removes both directory and state", async () => {
    const install = store.install({
      pluginId: "csv-table",
      files: [{ name: "preview.html", bytes: encode("body") }],
      manifest: manifestFor("csv-table"),
      source: { kind: "registry", registryUrl: REGISTRY_URL },
    });
    const uninstall = store.uninstall("csv-table");

    await Promise.all([install, uninstall]);

    expect(await store.list()).toEqual([]);
    expect(await readdir(tempDir)).toEqual(["installed.json"]);
  });

  test("keeps a plugin whose manifest went missing, with its enabled state", async () => {
    await writePlugin("csv-table");
    await store.install({
      pluginId: "csv-table",
      files: [{ name: "preview.html", bytes: encode("body") }],
      manifest: manifestFor("csv-table"),
      source: { kind: "registry", registryUrl: REGISTRY_URL },
    });
    await store.setEnabled("csv-table", false);

    await rm(join(tempDir, "csv-table", "paseo-plugin.json"));

    const plugins = await store.list();
    expect(plugins).toMatchObject([
      {
        manifest: { id: "csv-table" },
        enabled: false,
        source: { kind: "registry", registryUrl: REGISTRY_URL },
        unavailableReason: "Manifest file is missing",
      },
    ]);
  });

  test("keeps readable state entries when installed.json is partly unreadable", async () => {
    await writePlugin("csv-table");
    await writeFile(
      join(tempDir, "installed.json"),
      JSON.stringify({
        version: 7,
        plugins: [
          { id: "csv-table", enabled: false, installedAt: "2024-01-01T00:00:00.000Z", source: {} },
          {
            id: "csv-table",
            enabled: false,
            installedAt: "2024-01-01T00:00:00.000Z",
            source: { kind: "local" },
          },
        ],
      }),
    );

    const plugins = await store.list();

    expect(plugins).toMatchObject([{ enabled: false, installedAt: "2024-01-01T00:00:00.000Z" }]);
  });

  test("sweeps scratch directories a crashed install left behind", async () => {
    await mkdir(join(tempDir, ".staging-csv-table-abc"), { recursive: true });
    await mkdir(join(tempDir, ".trash-csv-table-abc"), { recursive: true });
    await writePlugin("csv-table");

    expect(await store.list()).toHaveLength(1);
    expect(await readdir(tempDir)).toEqual(["csv-table", "installed.json"]);
  });

  test("listing again does not rewrite installed.json", async () => {
    await writePlugin("csv-table");
    await store.list();
    const first = (await stat(join(tempDir, "installed.json"))).mtimeMs;

    await store.list();

    expect((await stat(join(tempDir, "installed.json"))).mtimeMs).toBe(first);
  });

  test("refuses to serve a disabled plugin's entry", async () => {
    await writePlugin("csv-table");
    await store.setEnabled("csv-table", false);

    await expect(store.readEntry("csv-table", "preview.html")).rejects.toBeInstanceOf(
      PluginEntryUnavailableError,
    );
  });

  test("refuses to serve an html file the manifest never declared", async () => {
    await writePlugin("csv-table", {
      files: { "preview.html": "<h1>table</h1>", "private.html": "<h1>private</h1>" },
    });

    await expect(store.readEntry("csv-table", "private.html")).rejects.toBeInstanceOf(
      PluginEntryNotFoundError,
    );
  });

  test("refuses an entry that symlinks out of the plugin directory", async () => {
    await writePlugin("csv-table", { files: {} });
    await writeFile(join(tempDir, "secret.html"), "id_rsa");
    await symlink(join(tempDir, "secret.html"), join(tempDir, "csv-table", "preview.html"));

    await expect(store.readEntry("csv-table", "preview.html")).rejects.toBeInstanceOf(
      PluginPathTraversalError,
    );
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
