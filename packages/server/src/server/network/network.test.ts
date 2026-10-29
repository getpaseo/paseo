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
  await installed.close();
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
