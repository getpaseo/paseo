import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { initializeEnvironmentProxy, webSocketProxyAgent } from "./index.js";
const original = getGlobalDispatcher();
const servers: Server[] = [];
afterEach(async () => {
  const installed = getGlobalDispatcher();
  setGlobalDispatcher(original);
  if (installed !== original) await installed.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `127.0.0.1:${address.port}`;
}
async function proxy() {
  const tunnels: string[] = [];
  const server = createServer();
  server.on("connect", (request, socket) => {
    tunnels.push(request.url!);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  return { url: `http://${await listen(server)}`, tunnels };
}
test("loopback fetch and WebSockets bypass HTTP_PROXY with empty NO_PROXY", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, NO_PROXY: "" });
  const server = createServer((_, response) => response.end("direct"));
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.send("direct"));
  const address = await listen(server);
  expect(await (await fetch(`http://${address}`)).text()).toBe("direct");
  const socket = new WebSocket(`ws://${address}`, {
    agent: webSocketProxyAgent(`ws://${address}`),
  });
  expect((await once(socket, "message"))[0].toString()).toBe("direct");
  socket.close();
  await once(socket, "close");
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(webSocketProxyAgent(`wss://${host}:1234`)).toBeUndefined();
  expect(recorder.tunnels).toEqual([]);
});
test("fetch and WebSockets send non-loopback traffic through CONNECT", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ http_proxy: recorder.url });
  await expect(
    fetch("https://vendor.invalid/", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(
    recorder.tunnels.filter((host) => host === "vendor.invalid:443").length,
  ).toBeGreaterThanOrEqual(2);
});
test("NO_PROXY and absent variables keep matching WebSockets direct", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({
    HTTPS_PROXY: recorder.url,
    NO_PROXY: "vendor.invalid,.example.invalid:443",
  });
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
  await expect(
    fetch("https://vendor.invalid/", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(webSocketProxyAgent("wss://sub.example.invalid")).toBeUndefined();
  expect(webSocketProxyAgent("wss://example.invalid:444")).toBeDefined();
  initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, no_proxy: "*" });
  expect(webSocketProxyAgent("ws://vendor.invalid")).toBeUndefined();
  initializeEnvironmentProxy({});
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
  const address = await listen(createServer((_, response) => response.end("direct")));
  expect(await (await fetch(`http://${address}`)).text()).toBe("direct");
  expect(recorder.tunnels).toEqual([]);
});

test.each(["127.0.0.1", "localhost"])(
  "scheme-less %s proxies work for fetch and WebSockets",
  async (host) => {
    const recorder = await proxy();
    const address = new URL(recorder.url);
    initializeEnvironmentProxy({ https_proxy: `${host}:${address.port}` });
    await expect(
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    const socket = new WebSocket("wss://vendor.invalid", {
      agent: webSocketProxyAgent("wss://vendor.invalid"),
    });
    await once(socket, "error");
    expect(recorder.tunnels).toContain("vendor.invalid:443");
  },
);

test.each([
  "http://[",
  "http://user%zz:secret@proxy.corp",
  "socks5://127.0.0.1:7890",
  "ftp://proxy.corp:8080",
])("ignores invalid or unsupported proxy %s without stopping startup", async (value) => {
  const recorder = await proxy();
  expect(initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, https_proxy: value })).toEqual([
    "https_proxy",
  ]);
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test("daemon starts with an ignored proxy and writes one redacted warning to daemon.log", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daemon-invalid-proxy-"));
  const worker = fork(fileURLToPath(new URL("../daemon-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      PASEO_HOME: home,
      HOME: home,
      USERPROFILE: home,
      PASEO_LISTEN: "127.0.0.1:0",
      PASEO_RELAY_ENABLED: "0",
      https_proxy: "socks5://private:secret@127.0.0.1:7890",
    },
  });
  worker.stdout?.resume();
  let stderr = "";
  worker.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "paseo:ready"
        )
          resolve();
      });
      worker.on("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`)));
    });
    const log = await readFile(path.join(home, "daemon.log"), "utf8");
    const warnings = log
      .split("\n")
      .filter((line) => line.includes("Ignoring invalid or unsupported HTTP proxy variable"));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!).variable).toBe("https_proxy");
    expect(warnings[0]).not.toContain("secret");
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

test("accepts a scheme-less corporate proxy hostname", () => {
  expect(initializeEnvironmentProxy({ https_proxy: "proxy.corp:8080" })).toEqual([]);
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
});

test("an ignored lowercase variable falls back to the uppercase variable", async () => {
  const recorder = await proxy();
  expect(
    initializeEnvironmentProxy({
      https_proxy: "socks5://proxy.invalid",
      HTTPS_PROXY: recorder.url,
    }),
  ).toEqual(["https_proxy"]);
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});
