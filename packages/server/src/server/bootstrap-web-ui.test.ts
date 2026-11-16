import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, test } from "vitest";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const expectedHostName =
  process.platform === "darwin"
    ? execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim()
    : os.hostname();

interface InitialDaemonConnectionHint {
  listen: string;
  useTls: boolean;
  label: string;
  basePath?: string;
}

function fetchDaemonWebUi(options: {
  port: number;
  path?: string;
  headers?: Record<string, string>;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path ?? "/",
        headers: {
          host: `daemon.example.test:${options.port}`,
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Expected 200 from web UI, got ${res.statusCode ?? 0}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      },
    );
    req.on("error", reject);
  });
}

function readInjectedConnectionHint(html: string): InitialDaemonConnectionHint {
  const match = html.match(
    /window\.__PASEO_INITIAL_DAEMON_CONNECTION__=(?<json>\{[^<]+})<\/script>/,
  );
  if (!match?.groups?.json) {
    throw new Error("Missing initial daemon connection hint");
  }
  return JSON.parse(match.groups.json) as InitialDaemonConnectionHint;
}

describe("daemon web UI bootstrap", () => {
  let tempRoot: string | null = null;
  let daemonHandle: TestPaseoDaemon | null = null;

  async function createWebUiDist(): Promise<string> {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-bootstrap-web-ui-"));
    const distDir = path.join(tempRoot, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(distDir, "index.html"),
      "<!DOCTYPE html><html><head></head><body>app</body></html>",
    );
    await mkdir(path.join(distDir, "_expo", "static", "js", "web"), { recursive: true });
    await writeFile(
      path.join(distDir, "_expo", "static", "js", "web", "entry.js"),
      "console.log('entry');",
    );
    return distDir;
  }

  afterEach(async () => {
    await daemonHandle?.close();
    daemonHandle = null;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  test("returns 404 for missing metadata while serving web UI deep links", async () => {
    const distDir = await createWebUiDist();
    daemonHandle = await createTestPaseoDaemon({
      mcpEnabled: true,
      webUi: { enabled: true, distDir },
    });
    const origin = `http://127.0.0.1:${daemonHandle.port}`;
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/agents`);
    expect(metadata.status).toBe(404);
    expect(metadata.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await metadata.json()).toEqual({ error: "Not found" });

    const deepLink = await fetch(`${origin}/h/example/agent/123`);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("<body>app</body>");
  });

  test("advertises ComputerName as the hostname over HTTP and WebSocket", async () => {
    daemonHandle = await createTestPaseoDaemon({ mcpEnabled: false });
    const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/status`);
    expect(await response.json()).toMatchObject({ hostname: expectedHostName });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemonHandle.port}/ws`,
      clientId: "host-name-test",
      clientType: "mobile",
    });
    try {
      await client.connect();
      expect(client.getLastServerInfoMessage()?.hostname).toBe(expectedHostName);
    } finally {
      await client.close();
    }
  });

  test("injects a TLS initial connection hint only for HTTPS forwarded by a trusted proxy", async () => {
    const distDir = await createWebUiDist();

    daemonHandle = await createTestPaseoDaemon({
      mcpEnabled: false,
      webUi: {
        enabled: true,
        distDir,
      },
    });

    const httpHint = readInjectedConnectionHint(
      await fetchDaemonWebUi({ port: daemonHandle.port }),
    );
    const httpsHint = readInjectedConnectionHint(
      await fetchDaemonWebUi({
        port: daemonHandle.port,
        headers: { "x-forwarded-proto": "https" },
      }),
    );

    expect(httpHint).toEqual({
      listen: `daemon.example.test:${daemonHandle.port}`,
      useTls: false,
      label: expectedHostName,
    });
    expect(httpsHint).toEqual({
      listen: `daemon.example.test:${daemonHandle.port}`,
      useTls: true,
      label: expectedHostName,
    });
  });

  test("spells out the scheme default port when the Host header omits it", async () => {
    const distDir = await createWebUiDist();

    daemonHandle = await createTestPaseoDaemon({
      mcpEnabled: false,
      webUi: {
        enabled: true,
        distDir,
      },
    });

    // A browser reaching a proxy that terminates TLS on 443 sends a Host header
    // with no port at all. The app rejects a portless `listen`, so the daemon
    // has to supply the default itself.
    const httpsHint = readInjectedConnectionHint(
      await fetchDaemonWebUi({
        port: daemonHandle.port,
        headers: { host: "paseo.example.test", "x-forwarded-proto": "https" },
      }),
    );
    const httpHint = readInjectedConnectionHint(
      await fetchDaemonWebUi({
        port: daemonHandle.port,
        headers: { host: "paseo.example.test" },
      }),
    );
    const ipv6Hint = readInjectedConnectionHint(
      await fetchDaemonWebUi({
        port: daemonHandle.port,
        headers: { host: "[::1]", "x-forwarded-proto": "https" },
      }),
    );

    expect(httpsHint.listen).toBe("paseo.example.test:443");
    expect(httpHint.listen).toBe("paseo.example.test:80");
    expect(ipv6Hint.listen).toBe("[::1]:443");
  });

  test("ignores forwarded HTTPS when proxy trust is disabled", async () => {
    const distDir = await createWebUiDist();

    daemonHandle = await createTestPaseoDaemon({
      mcpEnabled: false,
      trustedProxies: [],
      webUi: {
        enabled: true,
        distDir,
      },
    });

    const httpsHint = readInjectedConnectionHint(
      await fetchDaemonWebUi({
        port: daemonHandle.port,
        headers: { "x-forwarded-proto": "https" },
      }),
    );

    expect(httpsHint).toEqual({
      listen: `daemon.example.test:${daemonHandle.port}`,
      useTls: false,
      label: expectedHostName,
    });
  });

  describe("under a base path", () => {
    const basePath = "/user/alice/paseo";

    async function connectWebSocket(url: string): Promise<void> {
      const client = new DaemonClient({
        url,
        clientId: "base-path-test",
        clientType: "browser",
      });
      try {
        await client.connect();
        expect(client.getLastServerInfoMessage()?.hostname).toBe(expectedHostName);
      } finally {
        await client.close();
      }
    }

    test("serves the web UI, assets, and API under the prefix and advertises it in the hint", async () => {
      const distDir = await createWebUiDist();
      daemonHandle = await createTestPaseoDaemon({
        mcpEnabled: false,
        basePath,
        webUi: { enabled: true, distDir },
      });
      const origin = `http://127.0.0.1:${daemonHandle.port}`;

      const asset = await fetch(`${origin}${basePath}/_expo/static/js/web/entry.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
      expect(await asset.text()).toBe("console.log('entry');");

      const deepLink = await fetch(`${origin}${basePath}/h/example/agent/123`);
      expect(deepLink.status).toBe(200);
      expect(await deepLink.text()).toContain("<body>app</body>");

      const status = await fetch(`${origin}${basePath}/api/status`);
      expect(await status.json()).toMatchObject({ hostname: expectedHostName });

      for (const indexPath of [basePath, `${basePath}/`, `${basePath}/?x=1`]) {
        expect(
          readInjectedConnectionHint(
            await fetchDaemonWebUi({ port: daemonHandle.port, path: indexPath }),
          ),
        ).toEqual({
          listen: `daemon.example.test:${daemonHandle.port}`,
          useTls: false,
          label: expectedHostName,
          basePath,
        });
      }
    });

    test("accepts WebSocket connections at the prefixed and the root endpoint", async () => {
      daemonHandle = await createTestPaseoDaemon({ mcpEnabled: false, basePath });
      await connectWebSocket(`ws://127.0.0.1:${daemonHandle.port}${basePath}/ws`);
      await connectWebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`);
    });

    test("keeps serving unprefixed requests from proxies that strip the prefix", async () => {
      const distDir = await createWebUiDist();
      daemonHandle = await createTestPaseoDaemon({
        mcpEnabled: false,
        basePath,
        webUi: { enabled: true, distDir },
      });
      const origin = `http://127.0.0.1:${daemonHandle.port}`;

      const asset = await fetch(`${origin}/_expo/static/js/web/entry.js`);
      expect(await asset.text()).toBe("console.log('entry');");
      const hint = readInjectedConnectionHint(await fetchDaemonWebUi({ port: daemonHandle.port }));
      expect(hint.basePath).toBe(basePath);
    });

    test("does not treat a sibling path that shares the prefix as the base path", async () => {
      const distDir = await createWebUiDist();
      daemonHandle = await createTestPaseoDaemon({
        mcpEnabled: false,
        basePath,
        webUi: { enabled: true, distDir },
      });
      const response = await fetch(
        `http://127.0.0.1:${daemonHandle.port}${basePath}-other/_expo/static/js/web/entry.js`,
      );
      // Falls through to the SPA fallback instead of resolving the asset.
      expect(await response.text()).toContain("<body>app</body>");
    });
  });

  test("leaves the hint without a base path when none is configured", async () => {
    const distDir = await createWebUiDist();
    daemonHandle = await createTestPaseoDaemon({
      mcpEnabled: false,
      webUi: { enabled: true, distDir },
    });
    const hint = readInjectedConnectionHint(await fetchDaemonWebUi({ port: daemonHandle.port }));
    expect(hint).not.toHaveProperty("basePath");
    const prefixed = await fetch(
      `http://127.0.0.1:${daemonHandle.port}/user/alice/paseo/_expo/static/js/web/entry.js`,
    );
    expect(await prefixed.text()).toContain("<body>app</body>");
  });
});
