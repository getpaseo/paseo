import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProxyFetch, readClaudeSettingsProxy } from "./proxy.js";
import { discover, fetchUsage } from "./usage.js";

let directory: string;
const servers: Server[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claude-settings-proxy-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(directory, { recursive: true, force: true });
});

function writeSettings(env: Record<string, unknown> | undefined): string {
  const path = join(directory, "settings.json");
  writeFileSync(path, JSON.stringify(env === undefined ? { model: "opus" } : { env }));
  return path;
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

interface Tunnel {
  authority: string;
  headers: IncomingHttpHeaders;
}

/** A CONNECT proxy that records tunnels and forwards every one to `originPort`. */
async function startProxy(originPort: number | null, tunnels: Tunnel[]): Promise<number> {
  const proxy = createServer();
  proxy.on("connect", (request, client) => {
    tunnels.push({ authority: request.url!, headers: request.headers });
    if (originPort === null) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(originPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return listen(proxy);
}

/** A CONNECT proxy that never answers; `held` lists tunnels the client has not closed. */
async function startSilentProxy(held: Duplex[]): Promise<number> {
  // The proxy socket is half-open: the client's end is what an abort sends.
  const release = (socket: Duplex) => {
    held.splice(held.indexOf(socket), 1);
    socket.destroy();
  };
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => {
    held.push(socket);
    socket.once("end", () => release(socket));
  });
  return listen(proxy);
}

describe("readClaudeSettingsProxy", () => {
  it("prefers lowercase HTTPS variables, as the daemon does", async () => {
    const path = writeSettings({
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:2",
      https_proxy: "http://127.0.0.1:3",
    });
    expect((await readClaudeSettingsProxy(path))?.href).toBe("http://127.0.0.1:3/");
  });

  it("falls back to HTTP_PROXY and accepts a proxy without a scheme", async () => {
    const path = writeSettings({ HTTP_PROXY: "127.0.0.1:1133" });
    expect((await readClaudeSettingsProxy(path))?.href).toBe("http://127.0.0.1:1133/");
  });

  it("skips unsupported values and uses the next variable", async () => {
    const path = writeSettings({
      https_proxy: "socks5://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:2",
    });
    expect((await readClaudeSettingsProxy(path))?.href).toBe("http://127.0.0.1:2/");
  });

  it.each([
    ["no settings file", null],
    ["no env", undefined],
    ["no proxy variables", { API_TIMEOUT_MS: "600000" }],
    ["an empty proxy", { HTTPS_PROXY: " " }],
    ["a non-string proxy", { HTTPS_PROXY: 1133 }],
  ])("uses the daemon's policy with %s", async (_case, env) => {
    const path = env === null ? join(directory, "settings.json") : writeSettings(env);
    expect(await readClaudeSettingsProxy(path)).toBeNull();
  });

  it.each(["api.anthropic.com", ".anthropic.com", "*.anthropic.com", "*", "x, anthropic.com:443"])(
    "honors NO_PROXY entry %s",
    async (noProxy) => {
      const path = writeSettings({ HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: noProxy });
      expect(await readClaudeSettingsProxy(path)).toBeNull();
    },
  );

  it.each(["localhost,127.0.0.1,downloads.claude.ai", "api.anthropic.com:8443", "anthropic.co"])(
    "proxies past unrelated NO_PROXY entry %s",
    async (noProxy) => {
      const path = writeSettings({ HTTPS_PROXY: "http://127.0.0.1:1", no_proxy: noProxy });
      expect(await readClaudeSettingsProxy(path)).not.toBeNull();
    },
  );
});

describe("createProxyFetch", () => {
  // The origin speaks plain HTTP; tests replace the TLS handshake with the raw tunnel.
  const plaintext = <T>(tunnel: T) => tunnel;

  it("tunnels a GET through CONNECT with proxy credentials kept off the origin", async () => {
    const seen: { url?: string; headers?: IncomingHttpHeaders } = {};
    const origin = createServer((request, response) => {
      seen.url = request.url;
      seen.headers = request.headers;
      response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      response.end(JSON.stringify({ error: "slow down" }));
    });
    const tunnels: Tunnel[] = [];
    const proxyPort = await startProxy(await listen(origin), tunnels);
    const proxied = createProxyFetch(
      new URL(`http://us%40er:p%3Ass@127.0.0.1:${proxyPort}`),
      plaintext,
    );

    const response = await proxied("https://api.anthropic.com/api/oauth/usage?x=1", {
      headers: { Authorization: "Bearer token", "anthropic-beta": "oauth-2025-04-20" },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "slow down" });
    expect(tunnels.map((tunnel) => tunnel.authority)).toEqual(["api.anthropic.com:443"]);
    expect(tunnels[0]!.headers["proxy-authorization"]).toBe(
      `Basic ${Buffer.from("us@er:p:ss").toString("base64")}`,
    );
    expect(seen.url).toBe("/api/oauth/usage?x=1");
    expect(seen.headers?.host).toBe("api.anthropic.com");
    expect(seen.headers?.authorization).toBe("Bearer token");
    expect(seen.headers?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(seen.headers?.["proxy-authorization"]).toBeUndefined();
  });

  it("reports a refused tunnel without exposing proxy credentials", async () => {
    const proxyPort = await startProxy(null, []);
    const proxied = createProxyFetch(new URL(`http://user:secret@127.0.0.1:${proxyPort}`));
    const failure = proxied("https://api.anthropic.com/api/oauth/usage").catch(
      (error: Error) => error,
    );
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Proxy 127.0.0.1:${proxyPort} refused api.anthropic.com:443: HTTP 502`,
    );
    expect((error as Error).message).not.toContain("secret");
  });

  it("aborts a tunnel that never answers", async () => {
    const held: Duplex[] = [];
    const proxyPort = await startSilentProxy(held);
    const proxied = createProxyFetch(new URL(`http://127.0.0.1:${proxyPort}`));
    await expect(
      proxied("https://api.anthropic.com/api/oauth/usage", { signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow("The operation was aborted due to timeout");
    // The abort closes the tunnel instead of leaving it to the proxy.
    await expect.poll(() => held.length).toBe(0);
  });
});

describe("Claude account requests", () => {
  it("follow the proxy in the login's settings.json for discovery and usage", async () => {
    const tunnels: Tunnel[] = [];
    const proxyPort = await startProxy(null, tunnels);
    writeFileSync(
      join(directory, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fixture-settings-proxy" } }),
    );
    writeSettings({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` });

    const accounts = await discover(
      { kind: "global" },
      { home: directory, claudeHome: directory, env: {}, platform: "linux" },
    );
    const claude = accounts.find((account) => account.harness === "Claude");
    expect(claude?.input).toEqual({
      route: { store: "claude", path: join(directory, ".credentials.json") },
      settingsPath: join(directory, "settings.json"),
    });
    await expect(
      fetchUsage({
        route: { store: "claude", path: join(directory, ".credentials.json") },
        settingsPath: join(directory, "settings.json"),
      }),
    ).rejects.toThrow(`Proxy 127.0.0.1:${proxyPort} refused api.anthropic.com:443: HTTP 502`);
    expect(tunnels.map((tunnel) => tunnel.authority)).toEqual([
      "api.anthropic.com:443",
      "api.anthropic.com:443",
    ]);
  });
});
