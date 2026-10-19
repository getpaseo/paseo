import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createHostTransportFactory, HostTransportBudget } from "./index.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function endpoint() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return { wss, url: `ws://127.0.0.1:${address.port}/ws` };
}
test("connector retains per-attempt headers and WebSocket subprotocols", async () => {
  const server = await endpoint();
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url)({
    url: server.url,
    headers: { Authorization: "Bearer example" },
    protocols: ["paseo-test"],
  });
  cleanup.push(async () => transport.close());
  const [socket, request] = (await connected) as [WebSocket, import("node:http").IncomingMessage];
  expect(request.headers.authorization).toBe("Bearer example");
  expect(socket.protocol).toBe("paseo-test");
});
test("a slow consumer cannot exceed the shared byte budget and close releases reserved bytes", async () => {
  const server = await endpoint();
  const budget = new HostTransportBudget(4 * 1024 * 1024);
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url, budget)({ url: server.url });
  cleanup.push(async () => transport.close());
  const ready = new Promise<void>((resolve) => transport.onOpen(resolve));
  const [socket] = (await connected) as [WebSocket];
  socket.pause();
  await ready;
  const frame = new Uint8Array(1024 * 1024);
  for (let index = 0; index < 4; index++) transport.send(frame);
  expect(budget.bufferedBytes).toBe(4 * 1024 * 1024);
  expect(() => transport.send(frame)).toThrow("Connected host buffer limit reached");
  expect(budget.bufferedBytes).toBeLessThanOrEqual(budget.limit);
  transport.close();
  await expect.poll(() => budget.bufferedBytes).toBe(0);
});
