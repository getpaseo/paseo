import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import type { PluginRegistryIndex } from "@getpaseo/protocol/plugin/types";
import {
  createFetchPluginRegistryHttp,
  PLUGIN_DOWNLOAD_DEADLINE_MS,
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

  // The reason reaches every connected client, so a `file://` registry must not
  // hand the daemon user's name and directory layout down the relay.
  test("keeps the daemon's filesystem layout out of the reason", async () => {
    const http = createFakeHttp({
      failIndexWith: new Error(
        "ENOENT: no such file or directory, open '/home/someone/projects/registry/index.json'",
      ),
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    const reason = await client.browse().then(
      () => "resolved",
      (error: PluginRegistryUnavailableError) => error.reason,
    );

    expect(reason).toBe("ENOENT: no such file or directory, open '…/index.json'");
  });

  // The scrub stops at the first path segment containing a space, and the
  // segment it then leaves behind is the one it exists to remove: `C:\Users\` is
  // cut, `John Doe\` is not. A Windows daemon hands the user's full name to
  // every connected client; the same holds for any home directory with a space
  // in it.
  test("keeps a spaced-out home directory out of the reason too", async () => {
    const http = createFakeHttp({
      failIndexWith: new Error(
        "ENOENT: no such file or directory, open 'C:\\Users\\John Doe\\AppData\\Roaming\\paseo\\index.json'",
      ),
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    const reason = await client.browse().then(
      () => "resolved",
      (error: PluginRegistryUnavailableError) => error.reason,
    );

    expect(reason).not.toContain("John Doe");
  });

  // Allowing spaces inside a segment is what keeps `John Doe` out, and the
  // price is that a run between two paths could be swallowed as one segment.
  // The quotes `fs` puts around a path are what stop it — worth pinning, since
  // the alternative reading is that this scrub eats whole sentences.
  test("scrubs two paths in one message without eating the words between them", async () => {
    const http = createFakeHttp({
      failIndexWith: new Error(
        "EEXIST: '/home/someone/paseo/index.json' shadows '/etc/paseo/index.json'",
      ),
    });
    const client = new PluginRegistryClient({ registryUrl: REGISTRY_URL, http });

    const reason = await client.browse().then(
      () => "resolved",
      (error: PluginRegistryUnavailableError) => error.reason,
    );

    expect(reason).toBe("EEXIST: '…/index.json' shadows '…/index.json'");
  });

  // `browse` scrubs the reason; `download` builds its own out of the same class
  // of error one function down, and `PluginDownloadRejectedError` is on the
  // allowlist in `plugin-session.ts` that puts a message on the wire verbatim.
  // Driven through the real transport so the message is whatever the filesystem
  // actually says, not a hand-written one.
  test("keeps the daemon's filesystem layout out of a failed download's reason", async () => {
    const dir = join(tmpdir(), `paseo-registry-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const indexPath = join(dir, "index.json");
    try {
      const index = buildIndex({ url: pathToFileURL(join(dir, "preview.html")).href });
      await writeFile(indexPath, JSON.stringify(index));
      const client = new PluginRegistryClient({
        registryUrl: pathToFileURL(indexPath).href,
        http: createFetchPluginRegistryHttp(),
      });

      const reason = await client.download("csv-table").then(
        () => "resolved",
        (error: PluginDownloadRejectedError) => error.reason,
      );

      expect(reason).not.toContain(dir);
      expect(reason).not.toContain(tmpdir());
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
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

  // `z.url()` accepts `file:/tmp/index.json` and the config's protocol check
  // passes it, so the transport has to read it off the parsed URL too. A
  // `startsWith("file://")` test sent this one to `fetch`, which does not
  // implement the scheme: the config validated and Browse failed.
  test("reads a file URL written without the empty authority", async () => {
    const path = join(tmpdir(), `paseo-registry-${randomUUID()}.json`);
    await writeFile(path, PREVIEW_HTML);
    try {
      const http = createFetchPluginRegistryHttp();
      const bytes = await http.getBytes(`file:${path}`);

      expect(new TextDecoder().decode(bytes)).toBe(PREVIEW_HTML);
    } finally {
      await rm(path, { force: true });
    }
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

  // The per-request timeout is per request, so a registry that stalls every one
  // of a manifest's 64 files keeps the install running long past the 120s the
  // calling client waits. Only a wall clock over the whole loop bounds it.
  test("gives up when the files together run past the download deadline", async () => {
    const index = buildIndex();
    const second = structuredClone(index.plugins[0]!.files[0]!);
    second.name = "second.html";
    second.url = "https://plugins.paseo.sh/csv-table/second.html";
    index.plugins[0]!.files.push(second);
    const files = {
      "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML,
      "https://plugins.paseo.sh/csv-table/second.html": PREVIEW_HTML,
    };

    let clock = 1_000;
    const slow = createFakeHttp({ index, files });
    const stalling: PluginRegistryHttp = {
      getJson: (url) => slow.getJson(url),
      getBytes: (url, options) => {
        clock += PLUGIN_DOWNLOAD_DEADLINE_MS;
        return slow.getBytes(url, options);
      },
    };
    const client = new PluginRegistryClient({
      registryUrl: REGISTRY_URL,
      http: stalling,
      now: () => clock,
    });

    await expect(client.download("csv-table")).rejects.toThrow(/within 60000ms/);
    // The first file was fetched; the deadline stopped the second.
    expect(slow.byteRequests).toEqual(["https://plugins.paseo.sh/csv-table/preview.html"]);
  });

  // The index fetch is its own 30s request and it is part of what the calling
  // client is waiting through, so starting the clock after it puts the real
  // ceiling past the 120s RPC timeout this budget is documented to stay inside.
  test("counts the index fetch against the download deadline", async () => {
    let clock = 1_000;
    const slow = createFakeHttp({
      index: buildIndex(),
      files: { "https://plugins.paseo.sh/csv-table/preview.html": PREVIEW_HTML },
    });
    const stalling: PluginRegistryHttp = {
      getJson: (url) => {
        clock += PLUGIN_DOWNLOAD_DEADLINE_MS;
        return slow.getJson(url);
      },
      getBytes: (url, options) => slow.getBytes(url, options),
    };
    const client = new PluginRegistryClient({
      registryUrl: REGISTRY_URL,
      http: stalling,
      now: () => clock,
    });

    await expect(client.download("csv-table")).rejects.toThrow(/within 60000ms/);
    // Not one file was even attempted: the index alone spent the budget.
    expect(slow.byteRequests).toEqual([]);
  });
});
