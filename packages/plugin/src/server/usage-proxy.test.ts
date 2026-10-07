import { createServer as createHttpServer } from "node:http";
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
          { proxyAttemptTimeoutMs: 2_000 },
        ),
      ).rejects.toThrow("Proxy response body exceeds limit");
    } finally {
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

async function startForwardProxy(): Promise<{
  port: number;
  proxyAuth: (string | null)[];
  close: () => Promise<void>;
}> {
  const proxyAuth: (string | null)[] = [];
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
      const absoluteUrl = requestLine?.split(" ")[1] ?? "";
      const target = new URL(absoluteUrl);
      const originForm = `${target.pathname}${target.search}`;
      const rewrittenHeaders = headers
        .filter(([name]) => name.toLowerCase() !== "proxy-authorization")
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      const method = requestLine?.split(" ")[0] ?? "GET";
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
