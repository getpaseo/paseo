import assert from "node:assert/strict";
import dns from "node:dns";
import { once } from "node:events";
import net from "node:net";
import { Writable } from "node:stream";
import pino from "pino";
import { WebSocketServer } from "ws";
import { startRelayTransport } from "../relay-transport.js";

// Match the reported runtime even on Node versions with a newer default.
net.setDefaultAutoSelectFamilyAttemptTimeout(250);
const order = process.argv[2];
assert.ok(order === "ipv4first" || order === "ipv6first");
dns.setDefaultResultOrder(order);

const logs: string[] = [];
const logger = pino(
  { level: "debug" },
  new Writable({
    write(chunk, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  }),
);
const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(relay, "listening");
const address = relay.address();
assert.ok(address && typeof address !== "string");
relay.on("connection", (socket, request) => {
  const url = new URL(request.url!, "http://relay-latency.test");
  if (url.searchParams.has("connectionId")) {
    socket.on("message", (data) => socket.send(data));
  } else {
    socket.send(JSON.stringify({ type: "sync", connectionIds: ["latency-client"] }));
  }
});

let complete!: () => void;
let fail!: (error: Error) => void;
const delivered = new Promise<void>((resolve, reject) => {
  complete = resolve;
  fail = reject;
});
const deadline = setTimeout(() => fail(new Error(logs.join(""))), 8_000);
const transport = startRelayTransport({
  logger,
  relayEndpoint: `relay-latency.test:${address.port}`,
  relayUseTls: false,
  serverId: "latency-server",
  attachSocket: async (socket) => {
    socket.on("message", (data) => {
      try {
        assert.equal(String(data), "latency round trip");
        complete();
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.send("latency round trip");
  },
});

try {
  await delivered;
  assert.ok(logs.some((line) => JSON.parse(line).msg === "relay_control_connected"));
  assert.ok(logs.some((line) => JSON.parse(line).msg === "relay_data_connected"));
  assert.ok(!logs.some((line) => JSON.parse(line).msg === "relay_error"));
  console.log("relay data round trip passed");
} finally {
  clearTimeout(deadline);
  await transport.stop();
  for (const socket of relay.clients) socket.terminate();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
}
