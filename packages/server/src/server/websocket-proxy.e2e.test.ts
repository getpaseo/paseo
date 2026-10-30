import { once } from "node:events";
import pino from "pino";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test.each([
  {
    name: "loopback proxy",
    trustedProxies: ["loopback"],
    forwarded: "100.64.0.7",
    address: "100.64.0.7",
    peer: "external",
  },
  {
    name: "untrusted proxy",
    trustedProxies: [],
    forwarded: "100.64.0.7",
    address: "127.0.0.1",
    peer: "loopback",
  },
  {
    name: "untrusted intermediary",
    trustedProxies: ["loopback"],
    forwarded: "192.0.2.9, 100.64.0.7",
    address: "100.64.0.7",
    peer: "external",
  },
])(
  "attributes WebSocket clients behind a $name",
  async ({ trustedProxies, forwarded, address, peer }) => {
    const logs: string[] = [];
    const daemon = await createTestPaseoDaemon({
      trustedProxies,
      logger: pino(
        { level: "info" },
        {
          write: (line) => {
            logs.push(line);
          },
        },
      ),
    });
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, {
      headers: { "X-Forwarded-For": forwarded },
    });
    try {
      await once(socket, "open");
      const connected = logs.find((line) =>
        line.includes('"msg":"Client connected; awaiting hello"'),
      );
      expect(connected).toContain(`"remoteAddress":"${address}"`);
      expect(connected).toContain(`"peer":"${peer}"`);
    } finally {
      socket.terminate();
      await daemon.close();
    }
  },
);
