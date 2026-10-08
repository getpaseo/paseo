import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as tcpConnect, createServer as createTcpServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  fetchWithAutoProxy,
  isProxyBypassed,
  requestThroughProxy,
  resolveUsageProxyUrl,
} from "./usage-proxy.js";

describe("resolveUsageProxyUrl", () => {
  it("prefers explicit proxy env vars and accepts HTTP or HTTPS proxies", async () => {
    await expect(resolveUsageProxyUrl({ env: { HTTPS_PROXY: "http://proxy:8080" } })).resolves.toBe(
      "http://proxy:8080/",
    );
    await expect(
      resolveUsageProxyUrl({ env: { HTTPS_PROXY: "https://secure-proxy:8443" } }),
    ).resolves.toBe("https://secure-proxy:8443/");
    await expect(resolveUsageProxyUrl({ env: { https_proxy: "proxy:8080" } })).resolves.toBe(
      "http://proxy:8080/",
    );
  });

  it("rejects unsupported proxy schemes", async () => {
    const closed = await closedPort();
    await expect(
      resolveUsageProxyUrl({ env: { HTTPS_PROXY: "ftp://proxy:21" }, probePort: closed }),
    ).resolves.toBeNull();
  });

  it("auto-detects a loopback proxy", async () => {
    const listener = await listenTcp();
    try {
      await expect(
        resolveUsageProxyUrl({ env: {}, probePort: listener.port }),
      ).resolves.toBe(`http://127.0.0.1:${listener.port}/`);
    } finally {
      await listener.close();
    }
  });
});

describe("isProxyBypassed", () => {
  it("matches domains and subdomains", () => {
    expect(isProxyBypassed(new URL("https://api.example.com/x"), { NO_PROXY: "example.com" })).toBe(
      true,
    );
    expect(isProxyBypassed(new URL("https://api.other.com/x"), { NO_PROXY: "example.com" })).toBe(
      false,
    );
  });

  it("honours port-specific exclusions", () => {
    const env = { NO_PROXY: "example.com:8443" };
    expect(isProxyBypassed(new URL("https://example.com:8443/x"), env)).toBe(true);
    expect(isProxyBypassed(new URL("https://example.com/x"), env)).toBe(false);
  });

  it("matches IPv6 without splitting the address at colons", () => {
    expect(isProxyBypassed(new URL("http://[::1]:8080/x"), { NO_PROXY: "[::1]:8080" })).toBe(
      true,
    );
    expect(isProxyBypassed(new URL("http://[::1]:8081/x"), { NO_PROXY: "[::1]:8080" })).toBe(
      false,
    );
    expect(isProxyBypassed(new URL("http://[::1]:8081/x"), { NO_PROXY: "::1" })).toBe(true);
  });
});

describe("fetchWithAutoProxy", () => {
  it("routes HTTP requests through a proxy and keeps proxy credentials out of the origin", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        { headers: { Authorization: "Bearer token" } },
        { env: { HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(proxy.proxyAuth).toEqual([`Basic ${Buffer.from("user:pw").toString("base64")}`]);
      expect(origin.requests[0]?.headers["authorization"]).toBe("Bearer token");
      expect(origin.requests[0]?.headers["proxy-authorization"]).toBeUndefined();
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it("redacts proxy credentials from fallback logs", async () => {
    const origin = await startOrigin();
    const breaker = await startBreakingProxy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {},
        { env: { HTTPS_PROXY: `http://secret-user:secret-pw@127.0.0.1:${breaker.port}` } },
      );
      expect(response.status).toBe(200);
      expect(warn).toHaveBeenCalledOnce();
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).not.toContain("secret-user");
      expect(message).not.toContain("secret-pw");
      expect(message).toContain(`http://127.0.0.1:${breaker.port}/`);
    } finally {
      warn.mockRestore();
      await breaker.close();
      await origin.close();
    }
  });

  it("falls back direct before the caller deadline when a proxy stalls", async () => {
    const origin = await startOrigin();
    const staller = await startStallingProxy();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        { signal: AbortSignal.timeout(1_000) },
        {
          env: { HTTPS_PROXY: `http://127.0.0.1:${staller.port}` },
          proxyAttemptTimeoutMs: 50,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(origin.requests).toHaveLength(1);
    } finally {
      await staller.close();
      await origin.close();
    }
  });

  it("honours a port-specific NO_PROXY rule", async () => {
    const origin = await startOrigin();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {},
        {
          env: {
            HTTPS_PROXY: `http://127.0.0.1:${await closedPort()}`,
            NO_PROXY: `127.0.0.1:${origin.port}`,
          },
        },
      );
      expect(response.status).toBe(200);
      expect(origin.requests).toHaveLength(1);
    } finally {
      await origin.close();
    }
  });

  it("does not retain a chunked response beyond the 10 MiB cap", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    try {
      await expect(
        requestThroughProxy(
          new URL(`http://127.0.0.1:${origin.port}/large-chunked`),
          `http://127.0.0.1:${proxy.port}`,
          {},
          { proxyAttemptTimeoutMs: 10_000 },
        ),
      ).rejects.toThrow("Proxy response body exceeds limit");
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it("treats 205 responses as bodyless instead of throwing from Response construction", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    try {
      const response = await requestThroughProxy(
        new URL(`http://127.0.0.1:${origin.port}/reset`),
        `http://127.0.0.1:${proxy.port}`,
      );
      expect(response.status).toBe(205);
      expect(await response.text()).toBe("");
    } finally {
      await proxy.close();
      await origin.close();
    }
  });

  it("sends the HTTPS request over the CONNECT tunnel rather than opening a direct socket", async () => {
    const origin = await startHttpsOrigin();
    const proxy = await startForwardProxy();
    const previousTlsSetting = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    try {
      const response = await requestThroughProxy(
        new URL(`https://127.0.0.1:${origin.port}/json`),
        `http://127.0.0.1:${proxy.port}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(proxy.connects).toEqual([`127.0.0.1:${origin.port}`]);
      expect(origin.remotePorts).toHaveLength(1);
      expect(proxy.connectUpstreamPorts).toContain(origin.remotePorts[0]);
    } finally {
      if (previousTlsSetting === undefined) {
        delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      } else {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previousTlsSetting;
      }
      await proxy.close();
      await origin.close();
    }
  });
});

interface OriginRequest {
  path: string;
  headers: Record<string, string>;
}

async function startOrigin(): Promise<{
  port: number;
  requests: OriginRequest[];
  close: () => Promise<void>;
}> {
  const requests: OriginRequest[] = [];
  const server = createHttpServer((req, res) => {
    req.resume();
    req.once("end", () => {
      requests.push({
        path: req.url ?? "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(", ") : (value ?? ""),
          ]),
        ),
      });
      if (req.url === "/large-chunked") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write(Buffer.alloc(6 * 1024 * 1024));
        res.end(Buffer.alloc(6 * 1024 * 1024));
        return;
      }
      if (req.url === "/reset") {
        res.writeHead(205, { "content-length": "0" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Origin did not bind");
  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const TEST_TLS_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIJh8QfIvSXtsX9QOlNIVpIE/c6/OGYWWqGCmMdZF73l4oAoGCCqGSM49
AwEHoUQDQgAELD7cgKCQUO478vQb/Itdu/KP4hdAaDPKEZWbzGrUQu7U92M6kvwt
Ck9bDj532zTh5YLkzeOo+nwkLCjyxPu8ZQ==
-----END EC PRIVATE KEY-----`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATSgAwIBAgIUSi58Pq6Xgz8ugjJa2b0r7QxcMm4wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAwODAwNDM0MVoXDTM2MTAwNTAw
NDM0MVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAELD7cgKCQUO478vQb/Itdu/KP4hdAaDPKEZWbzGrUQu7U92M6kvwtCk9b
Dj532zTh5YLkzeOo+nwkLCjyxPu8ZaNkMGIwHQYDVR0OBBYEFOu903WpCcmNgkmP
HVvcwtVqRslVMB8GA1UdIwQYMBaAFOu903WpCcmNgkmPHVvcwtVqRslVMA8GA1Ud
EwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEfwAAATAKBggqhkjOPQQDAgNIADBFAiEA
8iGIyRrgtsCgaT9OsHZ3RdkCZBHKrZrwnbusxeNcvO0CIDxsebRhmH66JadFX4ay
OacTTam1Ps8vpYeFrkwt7tgb
-----END CERTIFICATE-----`;

async function startHttpsOrigin(): Promise<{
  port: number;
  remotePorts: number[];
  close: () => Promise<void>;
}> {
  const remotePorts: number[] = [];
  const sockets = new Set<Socket>();
  const server = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
    req.resume();
    req.once("end", () => {
      if (req.socket.remotePort !== undefined) remotePorts.push(req.socket.remotePort);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTPS origin did not bind");
  return {
    port: address.port,
    remotePorts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startForwardProxy(): Promise<{
  port: number;
  proxyAuth: (string | null)[];
  connects: string[];
  connectUpstreamPorts: number[];
  close: () => Promise<void>;
}> {
  const proxyAuth: (string | null)[] = [];
  const connects: string[] = [];
  const connectUpstreamPorts: number[] = [];
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headEnd = buffered.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      client.removeListener("data", onData);
      const head = buffered.subarray(0, headEnd).toString("latin1");
      const rest = buffered.subarray(headEnd + 4);
      const [requestLine, ...headerLines] = head.split("\r\n");
      const headers: Array<[string, string]> = [];
      for (const line of headerLines) {
        const at = line.indexOf(":");
        if (at !== -1) headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
      }
      const proxyHeader = headers.find(([name]) => name.toLowerCase() === "proxy-authorization");
      proxyAuth.push(proxyHeader?.[1] ?? null);

      const method = requestLine?.split(" ")[0] ?? "GET";
      const requestTarget = requestLine?.split(" ")[1] ?? "";
      if (method === "CONNECT") {
        connects.push(requestTarget);
        const separator = requestTarget.lastIndexOf(":");
        const host = requestTarget.slice(0, separator).replace(/^\[|\]$/g, "");
        const port = Number(requestTarget.slice(separator + 1));
        const upstream = tcpConnect(port, host, () => {
          if (upstream.localPort !== undefined) connectUpstreamPorts.push(upstream.localPort);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        return;
      }

      const target = new URL(requestTarget);
      const originForm = `${target.pathname}${target.search}`;
      const rewrittenHeaders = headers
        .filter(([name]) => name.toLowerCase() !== "proxy-authorization")
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      const upstream = tcpConnect(target.port ? Number(target.port) : 80, target.hostname, () => {
        upstream.write(`${method} ${originForm} HTTP/1.1\r\n${rewrittenHeaders}\r\n\r\n`);
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  return {
    port: address.port,
    proxyAuth,
    connects,
    connectUpstreamPorts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startBreakingProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createTcpServer((client) => client.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Breaker did not bind");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startStallingProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Staller did not bind");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function listenTcp(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Listener did not bind");
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function closedPort(): Promise<number> {
  const server = createTcpServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe did not bind");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
