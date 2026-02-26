import { describe, expect, test } from "vitest";
import WebSocket from "ws";
import pino from "pino";
import { Writable } from "node:stream";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";

import { createTestJunctionDaemon } from "../test-utils/junction-daemon.js";
import { createClientChannel, type Transport } from "@junction/relay/e2ee";
import { buildRelayWebSocketUrl } from "../../shared/daemon-endpoints.js";

const nodeMajor = Number((process.versions.node ?? "0").split(".")[0] ?? "0");
const shouldRunRelayE2e = process.env.FORCE_RELAY_E2E === "1" || nodeMajor < 25;

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

async function waitForServer(port: number, timeout = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
}

async function waitForRelayWebSocketReady(port: number, timeout = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const serverId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const url = buildRelayWebSocketUrl({
      endpoint: `127.0.0.1:${port}`,
      serverId,
      role: "server",
    });
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 5000);
      ws.once("open", () => {
        clearTimeout(timer);
        ws.close(1000, "probe");
        resolve(true);
      });
      ws.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (opened) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Relay WebSocket endpoint not ready on port ${port} within ${timeout}ms`);
}

(shouldRunRelayE2e ? describe : describe.skip)("Relay transport (E2EE) - daemon E2E", () => {
  let relayPort: number;
  let relayProcess: ChildProcess | null = null;

  const startRelay = async () => {
    relayPort = await getAvailablePort();
    const relayDir = path.resolve(process.cwd(), "../relay");
    relayProcess = spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(relayPort),
        "--live-reload=false",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: relayDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      }
    );

    relayProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        // eslint-disable-next-line no-console
        console.log(`[relay] ${line}`);
      }
    });
    relayProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter((l) => l.trim());
      for (const line of lines) {
        // eslint-disable-next-line no-console
        console.error(`[relay] ${line}`);
      }
    });

    await waitForServer(relayPort, 30000);
    await waitForRelayWebSocketReady(relayPort, 60000);
  };

  const stopRelay = async () => {
    if (!relayProcess) return;
    relayProcess.kill("SIGTERM");
    relayProcess = null;
  };

  test(
    "daemon connects to relay and client ping/pong works through relay",
    async () => {
      process.env.JUNCTION_PRIMARY_LAN_IP = "192.168.1.12";

      const { logger, lines } = createCapturingLogger();
      await startRelay();

      const daemon = await createTestJunctionDaemon({
        listen: "127.0.0.1",
        logger,
        relayEnabled: true,
        relayEndpoint: `127.0.0.1:${relayPort}`,
      });

      try {
        const offerUrl = parseOfferUrlFromLogs(lines);
        const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);

        const stableClientId = `cid_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
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
              let pingSent = false;
              let channelRef: Awaited<ReturnType<typeof createClientChannel>> | null = null;
              const channel = await createClientChannel(
                transport,
                daemonPublicKeyB64,
                {
                  onmessage: (data) => {
                    try {
                      const payload =
                        typeof data === "string" ? JSON.parse(data) : data;
                      if (payload && typeof payload === "object" && (payload as any).type === "welcome") {
                        if (!pingSent && channelRef) {
                          pingSent = true;
                          void channelRef.send(JSON.stringify({ type: "ping" }));
                        }
                        return;
                      }
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
              channelRef = channel;
              await channel.send(
                JSON.stringify({
                  type: "hello",
                  clientId: stableClientId,
                  clientType: "cli",
                  protocolVersion: 1,
                })
              );
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
        await stopRelay();
      }
    },
    90000
  );

  test(
    "daemon keeps relay socket open while idle (no handshake timeout loop)",
    async () => {
      process.env.JUNCTION_PRIMARY_LAN_IP = "192.168.1.12";

      const { logger, lines } = createCapturingLogger();
      await startRelay();

      const daemon = await createTestJunctionDaemon({
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
        const stableClientId = `cid_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

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
              let pingSent = false;
              let channelRef: Awaited<ReturnType<typeof createClientChannel>> | null = null;
              const channel = await createClientChannel(transport, daemonPublicKeyB64, {
                onmessage: (data) => {
                  const payload = typeof data === "string" ? JSON.parse(data) : data;
                  if (payload && typeof payload === "object" && (payload as any).type === "welcome") {
                    if (!pingSent && channelRef) {
                      pingSent = true;
                      void channelRef.send(JSON.stringify({ type: "ping" }));
                    }
                    return;
                  }
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
              channelRef = channel;
              await channel.send(
                JSON.stringify({
                  type: "hello",
                  clientId: stableClientId,
                  clientType: "cli",
                  protocolVersion: 1,
                })
              );
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
        await stopRelay();
      }
    },
    90000
  );
});
