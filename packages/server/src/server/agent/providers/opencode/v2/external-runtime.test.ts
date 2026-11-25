import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { V2Runtime } from "./runtime.js";
import { EXTERNAL_SERVER_PASSWORD_ENV, EXTERNAL_SERVER_URL_ENV } from "./external-server.js";
import { selectOpenCodeService } from "./service-selection.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not expose a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

function reserveClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a test port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

describe("V2Runtime against an external server", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await close(server);
    server = undefined;
  });

  test("reuses the configured server and never spawns a local one", async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    server = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url !== "/api/info") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.0.10", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
    });
    const port = await listen(server);
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: `http://127.0.0.1:${port}`, password: "secret" },
    });

    const first = await runtime.acquire();
    const second = await runtime.acquire();
    expect(first.client).toBe(second.client);
    expect(requests).toEqual([
      {
        url: "/api/info",
        authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      },
    ]);

    await first.release();
    await second.release();
    const refreshed = await runtime.acquire({ fresh: true });
    expect(refreshed.client).toBe(first.client);
    await refreshed.release();
    await runtime.shutdown();
    expect(requests).toHaveLength(1);
  });

  test("reports the external server as exited once it stops accepting connections", async () => {
    server = createServer((request, response) => {
      if (request.url !== "/api/info") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.0.10", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
    });
    const port = await listen(server);
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: `http://127.0.0.1:${port}` },
    });
    const connection = await runtime.acquire();
    const exited = connection.exited.then((error) => error.message);

    await close(server);
    server = undefined;
    await expect(connection.client.server.info()).rejects.toThrow();

    await expect(exited).resolves.toContain(`OpenCode server at http://127.0.0.1:${port} stopped`);
    await connection.release();
    await runtime.shutdown();
  });

  test("rediscovers the replacement URL and password after a registered service exits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-rediscovery-"));
    const file = path.join(root, "service.json");
    const start = async (password: string) => {
      const next = createServer((request, response) => {
        response.setHeader("connection", "close");
        const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
        if (request.url !== "/api/info" || request.headers.authorization !== expected) {
          response.writeHead(request.url === "/api/info" ? 401 : 404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: root } }));
      });
      const port = await listen(next);
      await writeFile(
        file,
        JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: 1, version: "2.4.1", password }),
      );
      return next;
    };
    server = await start("first-test-password");
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      selection: () => selectOpenCodeService({ file }),
    });
    let replacement: Server | undefined;
    try {
      const first = await runtime.acquire();
      const exited = first.exited;
      await close(server);
      server = undefined;
      await expect(first.client.server.info()).rejects.toThrow();
      await expect(exited).resolves.toMatchObject({
        message: expect.stringContaining("stopped accepting connections"),
      });
      replacement = await start("replacement-test-password");
      const recovered = await runtime.acquire();
      expect(recovered.client).not.toBe(first.client);
      expect((await recovered.client.server.info()).version).toBe("2.4.1");
      await Promise.all([first.release(), recovered.release()]);
    } finally {
      if (server) await close(server);
      server = undefined;
      if (replacement) await close(replacement);
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shares a replacement when concurrent acquisitions rediscover the same service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-opencode-concurrent-recovery-"));
    const file = path.join(root, "service.json");
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: root } }));
    });
    const port = await listen(server);
    await writeFile(
      file,
      JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: 1, version: "2.4.1" }),
    );
    let selections = 0;
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      selection: async () => {
        selections++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return selectOpenCodeService({ file });
      },
    });
    try {
      const recovered = await Promise.all([
        runtime.acquire(),
        runtime.acquire(),
        runtime.acquire(),
      ]);
      expect(new Set(recovered.map((connection) => connection.client)).size).toBe(1);
      expect(selections).toBe(3);
      await Promise.all(recovered.map((connection) => connection.release()));
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a static selection for an explicitly configured server", async () => {
    let infoRequests = 0;
    server = createServer((_request, response) => {
      infoRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.4.1", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
    });
    const port = await listen(server);
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      selection: {
        kind: "explicit",
        server: { url: `http://127.0.0.1:${port}` },
      },
    });
    try {
      const first = await runtime.acquire();
      await close(server);
      server = undefined;
      await expect(first.client.server.info()).rejects.toThrow();
      await expect(first.exited).resolves.toMatchObject({
        message: expect.stringContaining("stopped accepting connections"),
      });
      await expect(runtime.acquire()).rejects.toThrow("Cannot reach OpenCode v2 server");
      expect(infoRequests).toBe(1);
      await first.release();
    } finally {
      await runtime.shutdown();
    }
  });

  test("selects the external server from provider environment", async () => {
    const paths: Array<string | undefined> = [];
    server = createServer((request, response) => {
      paths.push(request.url);
      if (request.url !== "/api/info") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.0.10", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
    });
    const port = await listen(server);
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      settings: {
        env: {
          [EXTERNAL_SERVER_URL_ENV]: `http://127.0.0.1:${port}`,
          [EXTERNAL_SERVER_PASSWORD_ENV]: "",
        },
      },
    });

    const connection = await runtime.acquire();
    expect(paths).toEqual(["/api/info"]);
    await connection.release();
    await runtime.shutdown();
  });

  test("reports an unreachable configured server", async () => {
    const port = await reserveClosedPort();
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: `http://127.0.0.1:${port}` },
    });

    await expect(runtime.acquire()).rejects.toThrow(
      `Cannot reach OpenCode v2 server at http://127.0.0.1:${port}`,
    );
    await runtime.shutdown();
  });

  test("rejects session configuration that requires process isolation", async () => {
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: "http://127.0.0.1:1" },
    });
    await expect(runtime.acquire({ dedicated: true })).rejects.toThrow(
      "require an isolated server",
    );
    await runtime.shutdown();
  });

  test("rejects provider process environment on an explicit server", async () => {
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: "http://127.0.0.1:1" },
      settings: { env: { XDG_CONFIG_HOME: "/custom", PROVIDER_KEY: "secret" } },
    });
    await expect(runtime.acquire()).rejects.toThrow("XDG_CONFIG_HOME, PROVIDER_KEY");
    await runtime.shutdown();
  });

  test("rejects an unsupported explicit server version", async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "2.0.9", pid: 1, urls: [], paths: { tmp: "/tmp" } }));
    });
    const port = await listen(server);
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: `http://127.0.0.1:${port}` },
    });
    await expect(runtime.acquire()).rejects.toThrow("Unsupported OpenCode version 2.0.9");
    await runtime.shutdown();
  });
});
