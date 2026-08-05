import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { InstalledPlugin, PluginRegistryIndex } from "@getpaseo/protocol/plugin/types";
import type { PluginRegistryHttp } from "./registry-client.js";
import { PluginService } from "./service.js";

const REGISTRY_URL = "https://plugins.paseo.sh/index.json";
const PREVIEW_URL = "https://plugins.paseo.sh/csv-table/preview.html";
const PREVIEW_HTML = "<h1>table</h1>";
const logger = pino({ level: "silent" });

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildIndex(sha: string = sha256(PREVIEW_HTML)): PluginRegistryIndex {
  return {
    version: 1,
    plugins: [
      {
        manifest: {
          id: "csv-table",
          name: "CSV Table",
          version: "1.0.0",
          paseoVersion: ">=0.2.0",
          contributes: {
            filePreviews: [
              { id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" },
            ],
          },
        },
        files: [
          {
            name: "preview.html",
            url: PREVIEW_URL,
            sha256: sha,
            bytes: Buffer.byteLength(PREVIEW_HTML),
          },
        ],
      },
    ],
  };
}

function createFakeHttp(index: PluginRegistryIndex): PluginRegistryHttp {
  return {
    async getJson() {
      return index;
    },
    async getBytes(url) {
      if (url !== PREVIEW_URL) {
        throw new Error(`404 for ${url}`);
      }
      return new TextEncoder().encode(PREVIEW_HTML);
    },
  };
}

describe("PluginService", () => {
  let dir: string;

  function createService(index: PluginRegistryIndex): PluginService {
    return new PluginService({
      dir,
      daemonVersion: "0.2.6",
      registryUrl: REGISTRY_URL,
      http: createFakeHttp(index),
      logger,
    });
  }

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "plugin-service-test-")), "plugins");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("installs a verified plugin and lists it as available", async () => {
    const service = createService(buildIndex());

    const installed = await service.install("csv-table");

    expect(installed).toMatchObject({
      manifest: { id: "csv-table" },
      enabled: true,
      source: { kind: "registry", registryUrl: REGISTRY_URL },
      unavailableReason: null,
    });
    expect(await service.getEntry("csv-table", "preview.html")).toBe(PREVIEW_HTML);
  });

  test("a sha256 mismatch aborts the install with nothing written", async () => {
    const service = createService(buildIndex(sha256("tampered")));

    await expect(service.install("csv-table")).rejects.toThrow(/failed verification/);

    expect(await service.list()).toEqual([]);
    // Nothing but the daemon-owned state file: no plugin directory, no staging leftovers.
    expect(await readdir(dir).catch(() => [])).toEqual(["installed.json"]);
  });

  test("a failed reinstall leaves the previously installed copy intact", async () => {
    const service = createService(buildIndex());
    await service.install("csv-table");

    const tampered = createService(buildIndex(sha256("tampered")));
    await expect(tampered.install("csv-table")).rejects.toThrow(/failed verification/);

    expect(await service.getEntry("csv-table", "preview.html")).toBe(PREVIEW_HTML);
  });

  test("notifies listeners on install, disable, and uninstall", async () => {
    const service = createService(buildIndex());
    const seen: InstalledPlugin[][] = [];
    const unsubscribe = service.onChanged((plugins) => seen.push(plugins));

    await service.install("csv-table");
    await service.setEnabled("csv-table", false);
    await service.uninstall("csv-table");
    unsubscribe();
    await service.list();

    expect(seen).toHaveLength(3);
    expect(seen[0]?.[0]?.enabled).toBe(true);
    expect(seen[1]?.[0]?.enabled).toBe(false);
    expect(seen[2]).toEqual([]);
  });

  test("browse surfaces the registry listing", async () => {
    const service = createService(buildIndex());

    expect((await service.browse()).map((entry) => entry.manifest.id)).toEqual(["csv-table"]);
    expect(service.registryUrl).toBe(REGISTRY_URL);
  });
});
