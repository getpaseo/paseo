import { describe, expect, it, test } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, type Socket } from "node:net";
import {
  balanceToneFromRemaining,
  fetchWithAutoProxy,
  isProxyBypassed,
  resolveUsageProxyUrl,
  toneFromUsedPct,
  usedPctOf,
  windowFromUsedPct,
  windowFromReportedDuration,
} from "./usage.js";

test("shared usage tones preserve the app threshold contract", () => {
  expect([null, 69.9, 70, 90, 90.1].map(toneFromUsedPct)).toEqual([
    "default",
    "ok",
    "warning",
    "warning",
    "danger",
  ]);
  expect([null, 0, 0.01].map(balanceToneFromRemaining)).toEqual(["default", "danger", "ok"]);
});

test("shared windows retain percentage and reset time", () => {
  expect(windowFromUsedPct({ id: "a", label: "A", utilizationPct: 30 })).toEqual({
    id: "a",
    label: "A",
    usedPct: 30,
    remainingPct: 70,
    resetsAt: null,
  });
  expect(windowFromUsedPct({ id: "b", label: "B", utilizationPct: null })).toEqual({
    id: "b",
    label: "B",
    usedPct: null,
    remainingPct: null,
    resetsAt: null,
  });
  expect(usedPctOf(25, 100)).toBe(25);
  expect(usedPctOf(25, 0)).toBeNull();
});

describe("toneFromUsedPct", () => {
  // Thresholds must match deriveTone in the app's provider-usage/tone.ts, which is what
  // the client applies when a window arrives without a tone.
  it.each([
    [0, "ok"],
    [69.9, "ok"],
    [70, "warning"],
    [90, "warning"],
    [90.1, "danger"],
    [100, "danger"],
    [150, "danger"],
  ])("%s%% used is %s", (usedPct, expected) => {
    expect(toneFromUsedPct(usedPct)).toBe(expected);
  });

  it("is neutral when the percentage is unknown", () => {
    expect(toneFromUsedPct(null)).toBe("default");
    expect(toneFromUsedPct(undefined)).toBe("default");
  });
});

describe("usedPctOf", () => {
  it("computes a percentage of the limit", () => {
    expect(usedPctOf(15.79, 42.5)).toBeCloseTo(37.15, 2);
  });

  it("is unknown when either side is missing", () => {
    expect(usedPctOf(null, 100)).toBeNull();
    expect(usedPctOf(50, null)).toBeNull();
  });

  // A zero limit would divide to Infinity and render as a full red bar.
  it("is unknown when the limit is zero or negative", () => {
    expect(usedPctOf(50, 0)).toBeNull();
    expect(usedPctOf(50, -1)).toBeNull();
  });
});

describe("balanceToneFromRemaining", () => {
  // Kept for balances with no limit, where no percentage can be computed. It only
  // escalates at exhaustion, which is why anything with a limit should use
  // toneFromUsedPct instead.
  it("stays ok until nothing is left", () => {
    expect(balanceToneFromRemaining(0.01)).toBe("ok");
    expect(balanceToneFromRemaining(0)).toBe("danger");
    expect(balanceToneFromRemaining(null)).toBe("default");
  });
});

test.each([
  [18000, "five_hour", "5-hour", "5h"],
  [604800, "weekly", "Weekly", "wk"],
  [7200, "7200s", "2-hour", "2h"],
  [86400, "86400s", "1-day", "1d"],
  [90, "90s", "90-second", "90s"],
  [null, "primary", "Primary limit", ""],
])(
  "duration %s owns the window's identity and both names",
  (durationSeconds, id, label, shortLabel) => {
    expect(
      windowFromReportedDuration({
        durationSeconds: durationSeconds as number | null,
        unknown: { id: "primary", label: "Primary limit", shortLabel: "" },
        utilizationPct: 11,
      }),
    ).toMatchObject({ id, label, shortLabel, usedPct: 11 });
  },
);

describe("resolveUsageProxyUrl", () => {
  it("prefers explicit proxy env vars, upper- then lowercase", async () => {
    await expect(resolveUsageProxyUrl({ env: { HTTPS_PROXY: "http://proxy:8080" } })).resolves.toBe(
      "http://proxy:8080/",
    );
    await expect(resolveUsageProxyUrl({ env: { https_proxy: "http://proxy:8080" } })).resolves.toBe(
      "http://proxy:8080/",
    );
    await expect(resolveUsageProxyUrl({ env: { HTTP_PROXY: "http://proxy:8080" } })).resolves.toBe(
      "http://proxy:8080/",
    );
    await expect(
      resolveUsageProxyUrl({
        env: { HTTPS_PROXY: "http://secure:1", HTTP_PROXY: "http://plain:2" },
      }),
    ).resolves.toBe("http://secure:1/");
  });

  it("accepts schemeless values and rejects garbage", async () => {
    const closed = await closedPort();
    await expect(
      resolveUsageProxyUrl({ env: { HTTPS_PROXY: "  127.0.0.1:7890  " } }),
    ).resolves.toBe("http://127.0.0.1:7890/");
    await expect(
      resolveUsageProxyUrl({ env: { HTTPS_PROXY: "" }, probePort: closed }),
    ).resolves.toBeNull();
    await expect(
      resolveUsageProxyUrl({ env: { HTTPS_PROXY: "ftp://proxy:21" }, probePort: closed }),
    ).resolves.toBeNull();
  });

  it("auto-detects a loopback proxy on 7890", async () => {
    // Either the test's own listener or a real local proxy answers: both prove
    // detection keys off an open port rather than configuration.
    const listener = await tryListen(7890);
    try {
      await expect(resolveUsageProxyUrl({ env: {} })).resolves.toBe("http://127.0.0.1:7890/");
    } finally {
      await listener?.close();
    }
  });

  it("returns null when nothing listens", async () => {
    await expect(
      resolveUsageProxyUrl({ env: {}, probePort: await closedPort() }),
    ).resolves.toBeNull();
  });
});

describe("isProxyBypassed", () => {
  it.each([
    [{ NO_PROXY: "example.com" }, "example.com", true],
    [{ NO_PROXY: "example.com" }, "api.example.com", true],
    [{ NO_PROXY: ".example.com" }, "api.example.com", true],
    [{ NO_PROXY: "other.com, example.com" }, "api.example.com", true],
    [{ NO_PROXY: "*" }, "anything.example", true],
    [{ NO_PROXY: "example.com:8080" }, "example.com", true],
    [{ no_proxy: "EXAMPLE.com" }, "example.com", true],
    [{ NO_PROXY: "other.com" }, "example.com", false],
    [{}, "example.com", false],
  ])("env %j bypasses %s: %s", (env, host, expected) => {
    expect(isProxyBypassed(host, env)).toBe(expected);
  });
});

describe("fetchWithAutoProxy", () => {
  it("routes http targets through the proxy with origin headers intact", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {
          headers: { Authorization: "Bearer token", Accept: "application/json" },
        },
        { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(origin.requests).toHaveLength(1);
      expect(origin.requests[0]).toMatchObject({ path: "/json", host: `127.0.0.1:${origin.port}` });
      expect(origin.requests[0]?.headers["authorization"]).toBe("Bearer token");
      expect(proxy.requests).toEqual([`http://127.0.0.1:${origin.port}/json`]);
    } finally {
      await origin.close();
      await proxy.close();
    }
  });

  it("parses chunked bodies and forwards POST payloads", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/chunked`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        },
        { env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("chunk-a|chunk-b");
      expect(origin.bodies).toEqual([JSON.stringify({ hello: "world" })]);
    } finally {
      await origin.close();
      await proxy.close();
    }
  });

  it("sends proxy credentials from the proxy URL", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {},
        {
          env: { HTTPS_PROXY: `http://user:pw@127.0.0.1:${proxy.port}` },
        },
      );
      expect(response.status).toBe(200);
      expect(proxy.proxyAuth).toEqual([`Basic ${Buffer.from("user:pw").toString("base64")}`]);
    } finally {
      await origin.close();
      await proxy.close();
    }
  });

  it("falls back to direct when the proxy breaks", async () => {
    const origin = await startOrigin();
    const breaker = await startBreakingProxy();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {},
        {
          env: { HTTPS_PROXY: `http://127.0.0.1:${breaker.port}` },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(origin.requests).toHaveLength(1);
    } finally {
      await origin.close();
      await breaker.close();
    }
  });

  it("honours NO_PROXY even with a dead proxy configured", async () => {
    const origin = await startOrigin();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {},
        {
          env: { HTTPS_PROXY: `http://127.0.0.1:${await closedPort()}`, NO_PROXY: "127.0.0.1" },
        },
      );
      expect(response.status).toBe(200);
      expect(origin.requests).toHaveLength(1);
    } finally {
      await origin.close();
    }
  });

  it("goes direct when no proxy is configured", async () => {
    const origin = await startOrigin();
    try {
      const response = await fetchWithAutoProxy(
        `http://127.0.0.1:${origin.port}/json`,
        {},
        {
          env: {},
          probePort: await closedPort(),
        },
      );
      expect(response.status).toBe(200);
      expect(origin.requests).toHaveLength(1);
    } finally {
      await origin.close();
    }
  });

  it("rejects a refused CONNECT and surfaces the fallback failure", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy({ connectStatus: 403 });
    try {
      // No TLS server answers behind the plain-HTTP origin, so the direct
      // fallback must fail too; the assertion is that CONNECT was attempted
      // first and the proxy refusal did not hang.
      await expect(
        fetchWithAutoProxy(
          `https://127.0.0.1:${origin.port}/json`,
          {},
          {
            env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` },
          },
        ),
      ).rejects.toThrow();
      expect(proxy.connects).toEqual([`127.0.0.1:${origin.port}`]);
    } finally {
      await origin.close();
      await proxy.close();
    }
  });

  it("rejects an already-aborted request without touching the network", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWithAutoProxy(
        "http://127.0.0.1:9/unused",
        { signal: controller.signal },
        {
          env: {},
          probePort: await closedPort(),
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// --- Test doubles below. A minimal loopback-only forward proxy plus origin. ---

interface OriginRequest {
  path: string;
  host: string;
  headers: Record<string, string>;
}

interface TestOrigin {
  port: number;
  requests: OriginRequest[];
  bodies: string[];
  close: () => Promise<void>;
}

async function startOrigin(): Promise<TestOrigin> {
  const origin: TestOrigin = {
    port: 0,
    requests: [],
    bodies: [],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      origin.requests.push({
        path: req.url ?? "",
        host: req.headers.host ?? "",
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(", ") : (value ?? ""),
          ]),
        ),
      });
      origin.bodies.push(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/chunked") {
        res.writeHead(200, { "Content-Type": "text/plain", "Transfer-Encoding": "chunked" });
        res.write("chunk-a|");
        res.end("chunk-b");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Origin did not bind");
  origin.port = address.port;
  return origin;
}

interface TestProxy {
  port: number;
  connects: string[];
  requests: string[];
  proxyAuth: (string | null)[];
  close: () => Promise<void>;
}

async function startForwardProxy(options: { connectStatus?: number } = {}): Promise<TestProxy> {
  const proxy: TestProxy = {
    port: 0,
    connects: [],
    requests: [],
    proxyAuth: [],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = createTcpServer((client) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headEnd = buffered.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      client.removeListener("data", onData);
      const headRaw = buffered.subarray(0, headEnd);
      const rest = buffered.subarray(headEnd + 4);
      const head = headRaw.toString("latin1");
      const [requestLine, ...headerLines] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines ?? []) {
        const at = line.indexOf(":");
        if (at !== -1) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      if (requestLine?.startsWith("CONNECT ")) {
        const authority = (requestLine.split(" ")[1] ?? "").trim();
        proxy.connects.push(authority);
        if (options.connectStatus && options.connectStatus !== 200) {
          client.end(`HTTP/1.1 ${options.connectStatus} Forbidden\r\n\r\n`);
          return;
        }
        const [host, port] = authority.split(":");
        const tunnel = tcpConnect(Number(port ?? 443), host ?? "", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) tunnel.write(rest);
          client.pipe(tunnel);
          tunnel.pipe(client);
        });
        tunnel.on("error", () => client.destroy());
        client.on("error", () => tunnel.destroy());
        return;
      }
      const absoluteUrl = requestLine?.split(" ")[1] ?? "";
      proxy.requests.push(absoluteUrl);
      proxy.proxyAuth.push(headers["proxy-authorization"] ?? null);
      relayVerbatim(client, headRaw, requestLine ?? "", rest, absoluteUrl);
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  proxy.port = address.port;
  return proxy;
}

/**
 * Byte-verbatim relay: rewrites only the absolute-URI request target to
 * origin-form and pipes everything else untouched, so chunk framing and
 * trailers survive exactly as the origin sent them.
 */
function relayVerbatim(
  client: Socket,
  headRaw: Buffer,
  requestLine: string,
  rest: Buffer,
  absoluteUrl: string,
) {
  const target = new URL(absoluteUrl);
  const originForm = `${target.pathname}${target.search}`;
  const firstLineEnd = headRaw.indexOf("\r\n");
  const newHead = Buffer.concat([
    Buffer.from(requestLine.replace(absoluteUrl, originForm), "latin1"),
    headRaw.subarray(firstLineEnd),
  ]);
  const upstream = tcpConnect(target.port ? Number(target.port) : 80, target.hostname, () => {
    upstream.write(Buffer.concat([newHead, Buffer.from("\r\n\r\n", "latin1"), rest]));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
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

/** A loopback port that is closed right now (bound, read, then released). */
async function closedPort(): Promise<number> {
  const server = createTcpServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe did not bind");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Try to listen on `port`; returns null when something already answers there. */
async function tryListen(port: number): Promise<{ close: () => Promise<void> } | null> {
  const server = createTcpServer(() => {});
  const bound: boolean = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!bound) return null;
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
