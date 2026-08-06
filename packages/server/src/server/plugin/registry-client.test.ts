import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import type { PluginRegistryIndex } from "@getpaseo/protocol/plugin/types";
import {
  createFetchPluginRegistryHttp,
  PluginDownloadRejectedError,
  PluginDownloadVerificationError,
  PluginNotInRegistryError,
  PluginRegistryClient,
  PluginRegistryUnavailableError,
  type PluginRegistryHttp,
} from "./registry-client.js";

const REGISTRY_URL = "https://plugins.paseo.sh/index.json";
const PREVIEW_HTML = "<h1>table</h1>";

function ignoreSocketError(): void {}

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
  /** The `maxBytes` ceiling the client handed the transport, per request. */
  readonly byteLimits: Array<number | undefined>;
}

function createFakeHttp(options: {
  index?: unknown;
  files?: Record<string, string>;
  failIndexWith?: Error;
}): FakeHttp {
  const jsonRequests: string[] = [];
  const byteRequests: string[] = [];
  const byteLimits: Array<number | undefined> = [];
  return {
    jsonRequests,
    byteRequests,
    byteLimits,
    async getJson(url) {
      jsonRequests.push(url);
      if (options.failIndexWith) {
        throw options.failIndexWith;
      }
      return options.index;
    },
    async getBytes(url, byteOptions) {
      byteRequests.push(url);
      byteLimits.push(byteOptions?.maxBytes);
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

  test("reports an index whose envelope does not parse", async () => {
    const http = createFakeHttp({ index: { version: 1, plugins: "nope" } });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.browse()).rejects.toBeInstanceOf(PluginRegistryUnavailableError);
  });

  test("still browses an index version this daemon has never seen", async () => {
    const index = { ...buildIndex(), version: 2 };
    const http = createFakeHttp({ index });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    expect((await client.browse()).plugins.map((entry) => entry.manifest.id)).toEqual([
      "csv-table",
    ]);
  });

  test("drops a malformed entry instead of taking the whole index offline", async () => {
    const index = buildIndex();
    const http = createFakeHttp({
      index: {
        version: 1,
        plugins: [{ manifest: { id: "broken" }, files: [] }, ...index.plugins],
      },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    expect((await client.browse()).plugins.map((entry) => entry.manifest.id)).toEqual([
      "csv-table",
    ]);
  });

  test("caps each download at the size the index declared", async () => {
    const http = createFakeHttp({
      index: buildIndex(),
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await client.download("csv-table");

    expect(http.byteLimits).toEqual([Buffer.byteLength(PREVIEW_HTML)]);
  });

  test("download can force a fresh index", async () => {
    const http = createFakeHttp({
      index: buildIndex(),
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http, now: () => 0 });

    await client.browse();
    await client.download("csv-table", { refresh: true });

    expect(http.jsonRequests).toHaveLength(2);
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

  // Both entries verify against their own hash, and the second write wins — so
  // the file that lands is not the one whose hash the user's daemon checked.
  test("refuses an entry that lists the same file twice", async () => {
    const index = buildIndex();
    const first = index.plugins[0];
    if (!first?.files[0]) {
      throw new Error("fixture changed");
    }
    first.files = [first.files[0], { ...first.files[0], url: `${first.files[0].url}?v=2` }];
    const http = createFakeHttp({
      index,
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(PluginDownloadRejectedError);
    expect(http.byteRequests).toEqual([]);
  });

  test("aborts a body that streams past the declared size", async () => {
    // The index claims a kilobyte, the server streams megabytes with no
    // content-length: the transfer has to stop while reading, not after the
    // daemon buffered all of it.
    const server = createServer((_request, response) => {
      // The client aborts mid-stream, which resets the socket under us.
      response.on("error", ignoreSocketError);
      response.writeHead(200, { "transfer-encoding": "chunked" });
      const chunk = "x".repeat(64 * 1024);
      for (let written = 0; written < 2 * 1024 * 1024; written += chunk.length) {
        response.write(chunk);
      }
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    try {
      const http = createFetchPluginRegistryHttp();
      await expect(
        http.getBytes(`http://127.0.0.1:${port}/preview.html`, { maxBytes: 1024 }),
      ).rejects.toThrow(/1024 byte limit/);
    } finally {
      server.close();
    }
  });

  test("refuses a body whose declared content-length is over the cap", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "5000" });
      response.end("x".repeat(5000));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    try {
      const http = createFetchPluginRegistryHttp();
      await expect(
        http.getBytes(`http://127.0.0.1:${port}/preview.html`, { maxBytes: 10 }),
      ).rejects.toThrow(/10 byte limit/);
    } finally {
      server.close();
    }
  });

  test("refuses an entry the index does not ship a file for", async () => {
    const index = buildIndex();
    index.plugins[0]!.files[0]!.name = "other.html";
    const http = createFakeHttp({ index, files: {} });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    await expect(client.download("csv-table")).rejects.toBeInstanceOf(PluginDownloadRejectedError);
  });
});
