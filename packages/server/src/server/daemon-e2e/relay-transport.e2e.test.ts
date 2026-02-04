import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import pino from "pino";
import { Writable } from "node:stream";
import net from "node:net";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createRelayServer } from "@paseo/relay/node";

function createCapturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString("utf8"));
      cb();
    },
  });
  const logger = pino({ level: "info" }, stream);
  return { logger, lines };
}

function parseOfferUrlFromLogs(lines: string[]): string {
  for (const line of lines) {
    if (!line.includes("pairing_offer")) continue;
    try {
      const obj = JSON.parse(line) as { msg?: string; url?: string };
      if (obj.msg === "pairing_offer" && typeof obj.url === "string") {
        return obj.url;
      }
    } catch {
      // ignore
    }
  }
  throw new Error(`pairing_offer log not found. saw ${lines.length} lines`);
}

function decodeOfferFromFragmentUrl(url: string): { sessionId: string } {
  const marker = "#offer=";
  const idx = url.indexOf(marker);
  if (idx === -1) {
    throw new Error(`missing ${marker} fragment: ${url}`);
  }
  const encoded = url.slice(idx + marker.length);
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  const offer = JSON.parse(json) as { sessionId?: string };
  if (!offer.sessionId) throw new Error("offer.sessionId missing");
  return { sessionId: offer.sessionId };
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

describe("Relay transport (plaintext) - daemon E2E", () => {
  test(
    "daemon connects to relay and client ping/pong works through relay",
    async () => {
      process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

      const { logger, lines } = createCapturingLogger();
      const relayPort = await getAvailablePort();
      const relay = createRelayServer({ host: "127.0.0.1", port: relayPort });
      await relay.start();

      const daemon = await createTestPaseoDaemon({
        listen: "127.0.0.1",
        logger,
        relayEnabled: true,
        relayEndpoint: `127.0.0.1:${relayPort}`,
      });

      try {
        const offerUrl = parseOfferUrlFromLogs(lines);
        const { sessionId } = decodeOfferFromFragmentUrl(offerUrl);

        const ws = new WebSocket(
          `ws://127.0.0.1:${relayPort}/ws?session=${encodeURIComponent(
            sessionId
          )}&role=client`
        );

        const received = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("timed out waiting for pong"));
          }, 20000);

          ws.on("open", () => {
            ws.send(JSON.stringify({ type: "ping" }));
          });

          ws.on("message", (data) => {
            try {
              const parsed = JSON.parse(data.toString());
              if (parsed && typeof parsed === "object" && "type" in parsed && (parsed as any).type === "pong") {
                clearTimeout(timeout);
                resolve(parsed);
                ws.close();
              }
            } catch (err) {
              clearTimeout(timeout);
              reject(err);
            }
          });

          ws.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        expect(received).toEqual({ type: "pong" });
      } finally {
        await daemon.close();
        await relay.stop();
      }
    },
    30000
  );
});
