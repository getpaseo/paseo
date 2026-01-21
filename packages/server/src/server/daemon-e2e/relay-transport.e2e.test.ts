import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import pino from "pino";
import { Writable } from "node:stream";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

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

describe("Relay transport (plaintext) - daemon E2E", () => {
  test(
    "daemon connects to relay and client ping/pong works through relay",
    async () => {
      process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

      const { logger, lines } = createCapturingLogger();
      const daemon = await createTestPaseoDaemon({
        listen: "127.0.0.1",
        logger,
        relayEnabled: true,
        relayEndpoint: "relay.paseo.sh:443",
      });

      try {
        const offerUrl = parseOfferUrlFromLogs(lines);
        const { sessionId } = decodeOfferFromFragmentUrl(offerUrl);

        const ws = new WebSocket(
          `wss://relay.paseo.sh/ws?session=${encodeURIComponent(
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
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(data.toString()));
            } catch (err) {
              reject(err);
            } finally {
              ws.close();
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
      }
    },
    60000
  );
});

