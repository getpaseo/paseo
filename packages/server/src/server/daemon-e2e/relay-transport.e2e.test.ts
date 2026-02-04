import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import pino from "pino";
import { Writable } from "node:stream";
import net from "node:net";

import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createClientChannel, type Transport } from "@paseo/relay/e2ee";
import { createRelayServer } from "@paseo/relay/node";
import { buildRelayWebSocketUrl } from "../../shared/daemon-endpoints.js";

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

function decodeOfferFromFragmentUrl(url: string): {
  serverId: string;
  daemonPublicKeyB64: string;
} {
  const marker = "#offer=";
  const idx = url.indexOf(marker);
  if (idx === -1) {
    throw new Error(`missing ${marker} fragment: ${url}`);
  }
  const encoded = url.slice(idx + marker.length);
  const json = Buffer.from(encoded, "base64url").toString("utf8");
  const offer = JSON.parse(json) as { v?: unknown; serverId?: string; daemonPublicKeyB64?: string };
  if (offer.v !== 2) throw new Error("expected offer.v=2");
  if (!offer.serverId) throw new Error("offer.serverId missing");
  if (!offer.daemonPublicKeyB64) throw new Error("offer.daemonPublicKeyB64 missing");
  return { serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 };
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

describe("Relay transport (E2EE) - daemon E2E", () => {
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
        const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);

        const ws = new WebSocket(
          buildRelayWebSocketUrl({
            endpoint: `127.0.0.1:${relayPort}`,
            serverId,
            role: "client",
          })
        );

        const received = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("timed out waiting for pong"));
          }, 20000);

          const transport: Transport = {
            send: (data) => ws.send(data),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            onmessage: null,
            onclose: null,
            onerror: null,
          };

          ws.on("message", (data) => {
            transport.onmessage?.(typeof data === "string" ? data : data.toString());
          });
          ws.on("close", (code, reason) => {
            transport.onclose?.(code, reason.toString());
          });
          ws.on("error", (err) => {
            transport.onerror?.(err);
          });

          ws.on("open", async () => {
            try {
              const channel = await createClientChannel(
                transport,
                daemonPublicKeyB64,
                {
                  onmessage: (data) => {
                    try {
                      const payload =
                        typeof data === "string" ? JSON.parse(data) : data;
                      // The daemon may send an initial `server_info` status message
                      // immediately upon connect; ignore everything until we see `pong`.
                      if (payload && typeof payload === "object" && (payload as any).type === "pong") {
                        clearTimeout(timeout);
                        resolve(payload);
                        ws.close();
                      }
                    } catch (err) {
                      clearTimeout(timeout);
                      reject(err);
                    }
                  },
                  onerror: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                  },
                }
              );
              await channel.send(JSON.stringify({ type: "ping" }));
            } catch (err) {
              clearTimeout(timeout);
              reject(err);
            }
          });
        });

        expect(received).toEqual({ type: "pong" });
      } catch (err) {
        const tail = lines.slice(-50).join("");
        // Only prints on failure to help diagnose relay handshake issues.
        // eslint-disable-next-line no-console
        console.error("daemon logs (tail):\n", tail);
        throw err;
      } finally {
        await daemon.close();
        await relay.stop();
      }
    },
    30000
  );

  test(
    "daemon keeps relay socket open while idle (no handshake timeout loop)",
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
        const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);

        // Previously, the daemon would time out waiting for `hello` and reconnect every ~10s.
        // Wait long enough to catch that regression.
        await new Promise((r) => setTimeout(r, 12_000));

        const handshakeFailures = lines.filter((line) =>
          line.includes("relay_e2ee_handshake_failed")
        );
        expect(handshakeFailures.length).toBe(0);

        const ws = new WebSocket(
          buildRelayWebSocketUrl({
            endpoint: `127.0.0.1:${relayPort}`,
            serverId,
            role: "client",
          })
        );

        const received = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("timed out waiting for pong"));
          }, 20000);

          const transport: Transport = {
            send: (data) => ws.send(data),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            onmessage: null,
            onclose: null,
            onerror: null,
          };

          ws.on("message", (data) => {
            transport.onmessage?.(typeof data === "string" ? data : data.toString());
          });
          ws.on("close", (code, reason) => {
            transport.onclose?.(code, reason.toString());
          });
          ws.on("error", (err) => {
            transport.onerror?.(err);
          });

          ws.on("open", async () => {
            try {
              const channel = await createClientChannel(transport, daemonPublicKeyB64, {
                onmessage: (data) => {
                  const payload = typeof data === "string" ? JSON.parse(data) : data;
                  if (payload && typeof payload === "object" && (payload as any).type === "pong") {
                    clearTimeout(timeout);
                    resolve(payload);
                    ws.close();
                  }
                },
                onerror: (err) => {
                  clearTimeout(timeout);
                  reject(err);
                },
              });
              await channel.send(JSON.stringify({ type: "ping" }));
            } catch (err) {
              clearTimeout(timeout);
              reject(err);
            }
          });
        });

        expect(received).toEqual({ type: "pong" });
      } catch (err) {
        const tail = lines.slice(-50).join("");
        // eslint-disable-next-line no-console
        console.error("daemon logs (tail):\n", tail);
        throw err;
      } finally {
        await daemon.close();
        await relay.stop();
      }
    },
    45000
  );
});
