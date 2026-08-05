import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { PluginRegistryIndex } from "@getpaseo/protocol/plugin/types";
import {
  PluginDownloadRejectedError,
  PluginDownloadVerificationError,
  PluginNotInRegistryError,
  PluginRegistryClient,
  PluginRegistryUnavailableError,
  type PluginRegistryHttp,
} from "./registry-client.js";

const REGISTRY_URL = "https://plugins.paseo.sh/index.json";
const PREVIEW_HTML = "<h1>table</h1>";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildIndex(overrides?: {
  url?: string;
  sha256?: string;
  bytes?: number;
}): PluginRegistryIndex {
  return {
    version: 1,
    plugins: [
      {
        manifest: {
          id: "csv-table",
          name: "CSV Table",
          version: "1.0.0",
          contributes: {
            filePreviews: [
              { id: "table", title: "Table", extensions: [".csv"], entry: "preview.html" },
            ],
          },
        },
        files: [
          {
            name: "preview.html",
            url: overrides?.url ?? "https://plugins.paseo.sh/csv-table/preview.html",
            sha256: overrides?.sha256 ?? sha256(PREVIEW_HTML),
            bytes: overrides?.bytes ?? Buffer.byteLength(PREVIEW_HTML),
          },
        ],
      },
    ],
  };
}

interface FakeHttp extends PluginRegistryHttp {
  readonly jsonRequests: string[];
  readonly byteRequests: string[];
}

function createFakeHttp(options: {
  index?: unknown;
  files?: Record<string, string>;
  failIndexWith?: Error;
}): FakeHttp {
  const jsonRequests: string[] = [];
  const byteRequests: string[] = [];
  return {
    jsonRequests,
    byteRequests,
    async getJson(url) {
      jsonRequests.push(url);
      if (options.failIndexWith) {
        throw options.failIndexWith;
      }
      return options.index;
    },
    async getBytes(url) {
      byteRequests.push(url);
      const body = options.files?.[url];
      if (body === undefined) {
        throw new Error(`404 for ${url}`);
      }
      return new TextEncoder().encode(body);
    },
  };
}

describe("PluginRegistryClient", () => {
  test("parses the index and caches it until the TTL expires", async () => {
    const http = createFakeHttp({ index: buildIndex() });
    let clock = 1_000;
    const client = new PluginRegistryClient({
      registryUrl: REGISTRY_URL,
      http,
      cacheTtlMs: 5_000,
      now: () => clock,
    });

    expect((await client.browse()).plugins[0]?.manifest.id).toBe("csv-table");
    await client.browse();
    expect(http.jsonRequests).toHaveLength(1);

    clock += 6_000;
    await client.browse();
    expect(http.jsonRequests).toHaveLength(2);
  });

  test("refresh bypasses the cache", async () => {
    const http = createFakeHttp({ index: buildIndex() });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http, now: () => 0 });

    await client.browse();
    await client.browse({ refresh: true });

    expect(http.jsonRequests).toHaveLength(2);
  });

  test("reports an index that does not parse", async () => {
    const http = createFakeHttp({ index: { version: 2, plugins: [] } });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.browse()).rejects.toBeInstanceOf(PluginRegistryUnavailableError);
  });

  test("reports a transport failure", async () => {
    const http = createFakeHttp({ failIndexWith: new Error("ECONNREFUSED") });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.browse()).rejects.toBeInstanceOf(PluginRegistryUnavailableError);
  });

  test("downloads and verifies every file", async () => {
    const index = buildIndex();
    const http = createFakeHttp({
      index,
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    const download = await client.download("csv-table");

    expect(download.files).toHaveLength(1);
    expect(new TextDecoder().decode(download.files[0]!.bytes)).toBe(PREVIEW_HTML);
  });

  test("refuses a plugin the index does not list", async () => {
    const http = createFakeHttp({ index: buildIndex() });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("missing-plugin")).rejects.toBeInstanceOf(
      PluginNotInRegistryError,
    );
  });

  test("refuses a file whose sha256 does not match", async () => {
    const http = createFakeHttp({
      index: buildIndex({ sha256: sha256("something else") }),
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(
      PluginDownloadVerificationError,
    );
  });

  test("refuses a file whose byte length does not match", async () => {
    const http = createFakeHttp({
      index: buildIndex({ bytes: 999 }),
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(
      PluginDownloadVerificationError,
    );
  });

  test("refuses a plaintext http file url", async () => {
    const http = createFakeHttp({
      index: buildIndex({ url: "http://plugins.paseo.sh/csv-table/preview.html" }),
      files: { "http://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(PluginDownloadRejectedError);
    expect(http.byteRequests).toEqual([]);
  });

  test("allows file urls when the registry itself is a local file", async () => {
    const fileUrl = "file:///tmp/registry/csv-table/preview.html";
    const http = createFakeHttp({
      index: buildIndex({ url: fileUrl }),
      files: { [fileUrl]: PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({
      registryUrl: "file:///tmp/registry/index.json",
      http,
    });

    expect((await client.download("csv-table")).files).toHaveLength(1);
  });

  test("refuses an install whose declared size exceeds the cap", async () => {
    const http = createFakeHttp({
      index: buildIndex({ bytes: 100 }),
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http, maxTotalBytes: 10 });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(PluginDownloadRejectedError);
    expect(http.byteRequests).toEqual([]);
  });

  test("refuses an entry the index does not ship a file for", async () => {
    const index = buildIndex();
    index.plugins[0]!.files[0]!.name = "other.html";
    const http = createFakeHttp({ index, files: {} });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(PluginDownloadRejectedError);
  });
});
