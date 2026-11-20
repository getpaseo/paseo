import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { V2Runtime } from "./runtime.js";
import { EXTERNAL_SERVER_PASSWORD_ENV, EXTERNAL_SERVER_URL_ENV } from "./external-server.js";

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

  test("explicit target restrictions are described without contacting or starting a service", async () => {
    let starts = 0;
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
      startup: {
        select: async () => {
          throw new Error("explicit selection must win");
        },
        start: async () => {
          starts += 1;
          throw new Error("service must not start");
        },
      },
    });
    try {
      expect(await runtime.describeRestrictions()).toEqual({
        mcpConfiguration: "none",
        processEnvironment: "none",
      });
      expect(starts).toBe(0);
    } finally {
      await runtime.shutdown();
    }
  });

  test("shutdown cancels shared readiness without waiting for its deadline or stopping the service", async () => {
    let received!: () => void;
    const requested = new Promise<void>((resolve) => {
      received = resolve;
    });
    let aborted!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    server = createServer((request) => {
      request.once("aborted", aborted);
      received();
    });
    const port = await listen(server);
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: `http://127.0.0.1:${port}` },
    });
    const pending = runtime.acquire();
    const rejected = expect(pending).rejects.toThrow("runtime is closed");
    await requested;
    try {
      await runtime.shutdown();
      await rejected;
      await disconnected;
      expect(server.listening).toBe(true);
    } finally {
      await close(server);
      server = undefined;
      await runtime.shutdown();
    }
  }, 2_000);

  test("explicit server isolation errors never start a helper", async () => {
    let starts = 0;
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
      startup: {
        select: async () => {
          throw new Error("explicit selection must win");
        },
        start: async () => {
          starts += 1;
          throw new Error("helper must not start");
        },
      },
    });
    await expect(runtime.acquire({ dedicated: true })).rejects.toThrow(
      "require an isolated server",
    );
    await expect(runtime.acquire({ env: { TOKEN: "dummy" } })).rejects.toThrow(
      "require an isolated server",
    );
    expect(starts).toBe(0);
    await runtime.shutdown();
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
