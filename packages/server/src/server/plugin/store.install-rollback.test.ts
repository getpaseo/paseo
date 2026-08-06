import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginManifest } from "@getpaseo/protocol/plugin/types";
import { PluginStore } from "./store.js";

/**
 * The install swap is rename-into-place with the previous copy parked in a
 * trash directory. This file forces the case where the swap *and* the restore
 * both fail — the moment when the trash holds the user's only surviving copy —
 * which is impossible to provoke through the real filesystem. Everything but
 * the targeted rename runs for real.
 */
const state = vi.hoisted(() => ({ failRenameTo: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: async (from: string, to: string) => {
      if (state.failRenameTo !== null && to === state.failRenameTo) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return actual.rename(from, to);
    },
  };
});

const DAEMON_VERSION = "0.2.6";

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

describe("PluginStore install rollback", () => {
  let tempDir: string;
  let store: PluginStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "plugin-store-rollback-test-"));
    store = new PluginStore({ dir: tempDir, daemonVersion: DAEMON_VERSION });
  });

  afterEach(async () => {
    state.failRenameTo = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("keeps the trashed copy when the rollback itself fails", async () => {
    const pluginDir = join(tempDir, "csv-table");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "paseo-plugin.json"), JSON.stringify(manifestFor("csv-table")));
    await writeFile(join(pluginDir, "preview.html"), "old");
    await store.list();

    // Fails the swap into place and then the restore back out of the trash.
    state.failRenameTo = pluginDir;

    await expect(
      store.install({
        pluginId: "csv-table",
        files: [{ name: "preview.html", bytes: new TextEncoder().encode("new") }],
        manifest: manifestFor("csv-table"),
        source: { kind: "registry", registryUrl: "https://plugins.paseo.sh/index.json" },
      }),
    ).rejects.toThrow(/EACCES/);

    const trashed = (await readdir(tempDir)).filter((entry) => entry.startsWith(".trash-"));
    expect(trashed).toHaveLength(1);
    expect(await readFile(join(tempDir, trashed[0], "preview.html"), "utf-8")).toBe("old");

    // A leaked trash directory is swept on the next start, so leaking one costs
    // nothing while deleting it costs the user their plugin.
    state.failRenameTo = null;
    await new PluginStore({ dir: tempDir, daemonVersion: DAEMON_VERSION }).list();
    expect((await readdir(tempDir)).filter((entry) => entry.startsWith(".trash-"))).toEqual([]);
  });
});
