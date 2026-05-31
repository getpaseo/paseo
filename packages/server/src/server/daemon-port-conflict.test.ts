import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import {
  isAddressInUseError,
  isHealthyPaseoDaemonAt,
  PASEO_HEALTH_HEADER,
  PASEO_HEALTH_HEADER_VALUE,
} from "./daemon-port-conflict.js";

describe("isAddressInUseError", () => {
  test("detects EADDRINUSE errors", () => {
    expect(isAddressInUseError({ code: "EADDRINUSE" })).toBe(true);
  });

  test("ignores other error shapes", () => {
    expect(isAddressInUseError({ code: "ECONNREFUSED" })).toBe(false);
    expect(isAddressInUseError(new Error("boom"))).toBe(false);
    expect(isAddressInUseError(null)).toBe(false);
  });
});

describe("isHealthyPaseoDaemonAt", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  async function startServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    return (server!.address() as AddressInfo).port;
  }

  test("returns true when the port serves the Paseo health endpoint", async () => {
    const port = await startServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, {
          "content-type": "application/json",
          [PASEO_HEALTH_HEADER]: PASEO_HEALTH_HEADER_VALUE,
        });
        res.end(JSON.stringify({ status: "ok", timestamp: "now" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    expect(await isHealthyPaseoDaemonAt("127.0.0.1", port)).toBe(true);
  });

  test("returns false for a non-Paseo server occupying the port", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("hello from something else");
    });
    expect(await isHealthyPaseoDaemonAt("127.0.0.1", port)).toBe(false);
  });

  test("returns false for a generic health endpoint with the same JSON shape", async () => {
    const port = await startServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", timestamp: "now" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    expect(await isHealthyPaseoDaemonAt("127.0.0.1", port)).toBe(false);
  });

  test("returns false when nothing is listening on the port", async () => {
    // Bind then immediately release a port so we know it is free.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    expect(await isHealthyPaseoDaemonAt("127.0.0.1", freePort, { timeoutMs: 500 })).toBe(false);
  });
});
