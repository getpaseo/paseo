import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { hashSync } from "bcryptjs";
import { once } from "node:events";
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import type { DaemonClient as HostClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { withTimeout } from "../../utils/promise-timeout.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { WebSocket } from "ws";
import pino from "pino";
import { Writable } from "node:stream";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";

import { generateLocalPairingOffer } from "../pairing-offer.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { FILE_EXPLORER_STREAM_CHUNK_BYTES } from "../file-explorer/service.js";
import { createClientChannel, type Transport } from "@getpaseo/relay/e2ee";
import {
  deriveSharedKey,
  decrypt,
  encrypt,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
} from "@getpaseo/relay";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { ConnectionOfferSchema } from "@getpaseo/protocol/connection-offer";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/messages";

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
  const logger = pino({ level: "debug" }, stream);
  return { logger, lines };
}

async function getPairingOfferUrl(args: {
  paseoHome: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  appBaseUrl?: string;
}): Promise<string> {
  const pairing = await generateLocalPairingOffer({
    paseoHome: args.paseoHome,
    relayEnabled: args.relayEnabled,
    relayEndpoint: args.relayEndpoint,
    relayPublicEndpoint: args.relayPublicEndpoint,
    appBaseUrl: args.appBaseUrl,
    includeQr: false,
  });
  if (!pairing.url) {
    throw new Error("Expected relay pairing URL to be available");
  }
  return pairing.url;
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
  const offer = ConnectionOfferSchema.parse(JSON.parse(json));
  return { serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeCiphertext(ciphertext: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(ciphertext)).toString("base64");
}

function decodeCiphertext(text: string): ArrayBuffer {
  const buffer = Buffer.from(text, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

// Fixed transport key for an unsupported peer public key.
const UNSUPPORTED_PEER_TRANSPORT_KEY = Uint8Array.from(
  Buffer.from("351f86faa3b988468a850122b65b0acece9c4826806aeee63de9c0da2bd7f91e", "hex"),
);

function parseEncryptedJson(sharedKey: Uint8Array, text: string): unknown {
  const plaintext = new TextDecoder().decode(decrypt(sharedKey, decodeCiphertext(text)));
  return JSON.parse(plaintext);
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
      useTls: false,
      serverId,
      role: "server",
    });
    const opened = await new Promise<boolean>((resolve) => {
      let pendingResolve: ((value: boolean) => void) | null = resolve;
      const settle = (value: boolean) => {
        if (!pendingResolve) return;
        const fn = pendingResolve;
        pendingResolve = null;
        clearTimeout(timer);
        fn(value);
      };
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        settle(false);
      }, 5000);
      ws.once("open", () => {
        ws.close(1000, "probe");
        settle(true);
      });
      ws.once("error", () => {
        settle(false);
      });
    });
    if (opened) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Relay WebSocket endpoint not ready on port ${port} within ${timeout}ms`);
}

async function waitForCapturedLog(
  lines: string[],
  predicate: (line: string) => boolean,
  timeout = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (lines.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for captured log. Recent logs:\n${lines.slice(-20).join("")}`);
}

(shouldRunRelayE2e ? describe : describe.skip)("Relay transport (E2EE) - daemon E2E", () => {
  let relayPort: number;
  let relayProcess: ChildProcess | null = null;
  let relayStdoutLines: string[] = [];

  const startRelay = async (options: { useLocalRelay?: boolean; port?: number } = {}) => {
    relayStdoutLines = [];
    relayPort = options.port ?? (await getAvailablePort());
    const relayDir = path.resolve(process.cwd(), "../relay");
    const relayArgs = [
      "wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(relayPort),
      "--live-reload=false",
      "--show-interactive-dev-session=false",
    ];
    if (options.useLocalRelay) {
      relayArgs.push("--var", "PASEO_RELAY_UPSTREAM:");
    }
    relayProcess = spawn(
      process.execPath,
      [
        "--experimental-vm-modules",
        path.resolve(relayDir, "../../node_modules/wrangler/wrangler-dist/cli.js"),
        ...relayArgs.slice(1),
      ],
      {
        cwd: relayDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      },
    );

    relayProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data
        .toString()
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        relayStdoutLines.push(line);
        // eslint-disable-next-line no-console
        console.log(`[relay] ${line}`);
      }
    });
    relayProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data
        .toString()
        .split("\n")
        .filter((l) => l.trim());
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
    const process = relayProcess;
    relayProcess = null;
    const exited = once(process, "exit");
    process.kill("SIGTERM");
    await withTimeout(exited, 10000, "Local relay did not stop");
  };

  test("connected hosts route RPC and binary traffic through local E2EE relay and recover scopes", async () => {
    let a: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
    let b: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
    let origin: ReturnType<typeof createHostClient> | undefined;
    let api: PaseoApi | undefined;
    let remote: PaseoApi | undefined;
    let sibling: PaseoApi | undefined;
    let terminalRoute: Awaited<ReturnType<typeof openConnectedHostTerminal>> | undefined;
    let wire: Awaited<ReturnType<typeof relayWire>> | undefined;
    try {
      await startRelay({ useLocalRelay: true });
      const port = relayPort;
      b = await createTestPaseoDaemon({
        relayEnabled: true,
        relayEndpoint: `127.0.0.1:${port}`,
        relayUseTls: false,
        relayPublicUseTls: false,
        auth: { password: hashSync("relay-password", 4) },
      });
      a = await createTestPaseoDaemon();
      origin = createHostClient(`127.0.0.1:${a.port}`, { clientId: crypto.randomUUID() });
      await origin.connect();
      api = createPaseoApi(origin);
      const offerUrl = await getPairingOfferUrl({
        paseoHome: b.paseoHome,
        relayEnabled: true,
        relayEndpoint: b.config.relayEndpoint,
      });
      const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);
      wire = await relayWire(port);
      const connection = new URL(`relay://127.0.0.1:${wire.port}/${serverId}`);
      connection.searchParams.set("key", daemonPublicKeyB64);
      connection.searchParams.set("password", "wrong-password");
      const saved = await api.hosts.add({ connection: connection.toString() });
      await expect
        .poll(async () => (await api!.hosts.list()).hosts[0]?.error?.code, { timeout: 20000 })
        .toBe("authentication_failed");
      expect(JSON.stringify(await api.hosts.list())).not.toMatch(/wrong-password|relay-password/);
      connection.searchParams.set("password", "relay-password");
      await api.hosts.update(saved.registrationId, { connection: connection.toString() });
      await expect
        .poll(async () => (await api!.hosts.list()).hosts[0]?.status, { timeout: 20000 })
        .toBe("online");
      const admittedConnections = wire.connections();
      expect(wire.active()).toBe(1);
      remote = await api.hosts.client(serverId);
      sibling = await api.hosts.client(serverId);
      expect(wire.connections()).toBe(admittedConnections);
      expect(wire.active()).toBe(1);
      expect((await remote.workspaces.list()).entries).toEqual([]);
      const observed = await remote.workspaces.list({ subscribe: {} });
      let snapshots = 0;
      observed.subscription.subscribe({
        snapshot: () => {
          snapshots++;
        },
        update() {},
      });
      const workspace = await remote.workspaces.create({
        source: { kind: "directory", path: b.staticDir },
        title: "Relayed workspace",
      });
      const terminal = await workspace.terminals.create({
        command: process.execPath,
        args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
      });
      terminalRoute = await openConnectedHostTerminal(origin, serverId, terminal.id);
      expect(wire.connections()).toBe(admittedConnections);
      terminalRoute.write("ENCRYPTED_BINARY_BEFORE\n");
      await expect.poll(() => terminalRoute!.output()).toContain("ENCRYPTED_BINARY_BEFORE");
      terminalRoute.close();
      terminalRoute = undefined;
      const before = snapshots;
      await stopRelay();
      await expect
        .poll(
          async () => {
            try {
              await remote!.workspaces.list();
              return "online";
            } catch (error) {
              return (error as { code: string }).code;
            }
          },
          { timeout: 15000 },
        )
        .toBe("DAEMON_CONNECTION_LOST");
      await startRelay({ useLocalRelay: true, port });
      await expect
        .poll(
          async () => {
            try {
              return (await remote!.workspaces.list()).entries.length;
            } catch {
              return -1;
            }
          },
          { timeout: 30000 },
        )
        .toBe(1);
      await expect.poll(() => snapshots, { timeout: 15000 }).toBeGreaterThan(before);
      expect(wire.active()).toBe(1);
      terminalRoute = await openConnectedHostTerminal(origin, serverId, terminal.id);
      terminalRoute.write("ENCRYPTED_BINARY_AFTER\n");
      await expect.poll(() => terminalRoute!.output()).toContain("ENCRYPTED_BINARY_AFTER");
      terminalRoute.close();
      terminalRoute = undefined;
      await remote.dispose();
      remote = undefined;
      expect((await sibling.workspaces.list()).entries).toHaveLength(1);
      await sibling.terminals.ref(terminal.id).kill();
      await api.dispose();
      await expect(sibling.workspaces.list()).rejects.toThrow();
      const direct = createHostClient(`127.0.0.1:${b.port}`, {
        clientId: crypto.randomUUID(),
        password: "relay-password",
        reconnect: { enabled: false },
      });
      try {
        await direct.connect();
        const directApi = createPaseoApi(direct);
        expect((await directApi.workspaces.list()).entries).toHaveLength(1);
        await directApi.dispose();
      } finally {
        await direct.close();
      }
    } finally {
      terminalRoute?.close();
      await remote?.dispose();
      await sibling?.dispose();
      await api?.dispose();
      await origin?.close();
      await a?.close();
      await b?.close();
      await wire?.close();
      await stopRelay();
    }
  }, 120000);

  test("oversized attachments fail without disconnecting or resubmitting over the relay", async () => {
    await startRelay({ useLocalRelay: true });
    const daemon = await createTestPaseoDaemon({
      relayEnabled: true,
      relayEndpoint: `127.0.0.1:${relayPort}`,
      relayUseTls: false,
      relayPublicUseTls: false,
    });
    let client: DaemonClient | null = null;
    try {
      const offerUrl = await getPairingOfferUrl({
        paseoHome: daemon.paseoHome,
        relayEnabled: true,
        relayEndpoint: daemon.config.relayEndpoint,
      });
      const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);
      client = new DaemonClient({
        url: buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relayPort}`,
          useTls: false,
          serverId,
          role: "client",
        }),
        e2ee: { enabled: true, daemonPublicKeyB64 },
        reconnect: { baseDelayMs: 100, maxDelayMs: 100 },
      });
      await client.connect();
      const statuses: string[] = [];
      client.subscribeConnectionStatus((state) => statuses.push(state.status));
      for (const imageMiB of [30, 61]) {
        // Attachments are base64 in the JSON, then E2EE base64 expands the frame again.
        const images = [
          { data: "A".repeat(4 * Math.ceil((imageMiB * 1024 * 1024) / 3)), mimeType: "image/png" },
        ];
        await expect(
          withTimeout(
            client.createWorkspace({
              source: { kind: "directory", path: daemon.staticDir },
              agent: {
                provider: "claude",
                cwd: daemon.staticDir,
                initialPrompt: "Describe these screens.",
                images,
              },
            }),
            10000,
            "Workspace creation did not settle",
          ),
        ).rejects.toThrow(/too large.*32\.0 MiB/);
        expect((await client.fetchAgents()).entries).toEqual([]);
      }
      const agent = await client.createAgent({ provider: "claude", cwd: daemon.staticDir });
      await expect(
        client.sendMessage(agent.id, "Describe these screens.", {
          images: [{ data: "A".repeat(40 * 1024 * 1024), mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/too large.*32\.0 MiB/);
      await client.sendMessage(agent.id, "A small follow-up still works.");
      expect((await client.fetchAgents()).entries).toHaveLength(1);
      expect(statuses).toEqual(["connected"]);
    } finally {
      await client?.close();
      await daemon.close();
      await stopRelay();
    }
  }, 60000);

  test("daemon connects to relay and client ping/pong works through relay", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const { logger, lines } = createCapturingLogger();
    await startRelay();

    const daemon = await createTestPaseoDaemon({
      listen: "127.0.0.1",
      logger,
      relayEnabled: true,
      relayEndpoint: `127.0.0.1:${relayPort}`,
    });

    try {
      const offerUrl = await getPairingOfferUrl({
        paseoHome: daemon.paseoHome,
        relayEnabled: daemon.config.relayEnabled,
        relayEndpoint: daemon.config.relayEndpoint,
        relayPublicEndpoint: daemon.config.relayPublicEndpoint,
        appBaseUrl: daemon.config.appBaseUrl,
      });
      const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);

      const stableClientId = `cid_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      const ws = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relayPort}`,
          useTls: false,
          serverId,
          role: "client",
        }),
      );

      const received = await new Promise<unknown>((resolve, reject) => {
        let pendingResolve: ((value: unknown) => void) | null = resolve;
        let pendingReject: ((reason: unknown) => void) | null = reject;
        const settleResolve = (value: unknown) => {
          if (!pendingResolve) return;
          const fn = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          clearTimeout(timeout);
          fn(value);
        };
        const settleReject = (reason: unknown) => {
          if (!pendingReject) return;
          const fn = pendingReject;
          pendingResolve = null;
          pendingReject = null;
          clearTimeout(timeout);
          fn(reason);
        };
        const timeout = setTimeout(() => {
          ws.close();
          settleReject(new Error("timed out waiting for pong"));
        }, 20000);

        const transport: Transport = {
          send: (data) => ws.send(data),
          close: (code?: number, reason?: string) => ws.close(code, reason),
          onmessage: null,
          onclose: null,
          onerror: null,
        };

        ws.on("message", (data, isBinary) => {
          transport.onmessage?.({
            data: isBinary
              ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
              : data.toString(),
            isBinary,
          });
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
                try {
                  const payload = typeof data === "string" ? JSON.parse(data) : data;
                  const wsMsg = WSOutboundMessageSchema.safeParse(payload);
                  if (
                    wsMsg.success &&
                    wsMsg.data.type === "session" &&
                    wsMsg.data.message.type === "status" &&
                    wsMsg.data.message.payload?.status === "server_info"
                  ) {
                    if (!pingSent && channelRef) {
                      pingSent = true;
                      void channelRef.send(JSON.stringify({ type: "ping" }));
                    }
                    return;
                  }
                  if (wsMsg.success && wsMsg.data.type === "pong") {
                    settleResolve(wsMsg.data);
                    ws.close();
                  }
                } catch (err) {
                  settleReject(err);
                }
              },
              onerror: (err) => {
                settleReject(err);
              },
            });
            channelRef = channel;
            await channel.send(
              JSON.stringify({
                type: "hello",
                clientId: stableClientId,
                clientType: "cli",
                protocolVersion: 1,
              }),
            );
          } catch (err) {
            settleReject(err);
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
  }, 90000);

  test("daemon closes a relay client that sends an unsupported handshake key", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const { logger, lines } = createCapturingLogger();
    await startRelay({ useLocalRelay: true });

    const daemon = await createTestPaseoDaemon({
      listen: "127.0.0.1",
      logger,
      relayEnabled: true,
      relayEndpoint: `127.0.0.1:${relayPort}`,
    });

    try {
      const offerUrl = await getPairingOfferUrl({
        paseoHome: daemon.paseoHome,
        relayEnabled: daemon.config.relayEnabled,
        relayEndpoint: daemon.config.relayEndpoint,
        relayPublicEndpoint: daemon.config.relayPublicEndpoint,
        appBaseUrl: daemon.config.appBaseUrl,
      });
      const { serverId } = decodeOfferFromFragmentUrl(offerUrl);
      const ws = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relayPort}`,
          useTls: false,
          serverId,
          role: "client",
        }),
      );

      let receivedServerInfo = false;
      const isRelayDataConnectedLog = (line: string) => line.includes("relay_data_connected");
      const outcome = await new Promise<
        { type: "closed"; code: number; reason: string } | { type: "errored"; error: Error }
      >((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("timed out waiting for daemon to reject unsupported handshake key"));
        }, 20_000);

        ws.on("open", async () => {
          try {
            await waitForCapturedLog(lines, isRelayDataConnectedLog);
            ws.send(
              JSON.stringify({
                type: "e2ee_hello",
                key: exportPublicKey(new Uint8Array(32)),
              }),
            );
            ws.send(
              encodeCiphertext(
                encrypt(
                  UNSUPPORTED_PEER_TRANSPORT_KEY,
                  JSON.stringify({
                    type: "hello",
                    clientId: "cid_relay_unsupported_key",
                    clientType: "cli",
                    protocolVersion: 1,
                  }),
                ),
              ),
            );
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });

        ws.on("message", (data) => {
          try {
            const parsed = WSOutboundMessageSchema.parse(
              parseEncryptedJson(UNSUPPORTED_PEER_TRANSPORT_KEY, data.toString()),
            );
            if (
              parsed.type === "session" &&
              parsed.message.type === "status" &&
              parsed.message.payload?.status === "server_info"
            ) {
              receivedServerInfo = true;
              clearTimeout(timeout);
              reject(
                new Error("daemon sent server_info after accepting an unsupported handshake key"),
              );
            }
          } catch {
            // Plaintext e2ee_ready cannot be decrypted and is irrelevant to this assertion.
          }
        });
        ws.on("close", (code, reason) => {
          clearTimeout(timeout);
          resolve({ type: "closed", code, reason: reason.toString() });
        });
        ws.on("error", (error) => {
          clearTimeout(timeout);
          resolve({ type: "errored", error });
        });
      });

      expect(receivedServerInfo).toBe(false);
      if (outcome.type === "closed") {
        expect(outcome.code).toBeGreaterThan(0);
      } else {
        expect(outcome.error).toBeInstanceOf(Error);
      }

      const isRejectedHandshakeLog = (line: string) =>
        line.includes("relay_e2ee_handshake_failed") && line.includes("Invalid peer public key");
      await waitForCapturedLog(lines, isRejectedHandshakeLog);
      expect(lines.some(isRejectedHandshakeLog)).toBe(true);
    } finally {
      await daemon.close();
      await stopRelay();
    }
  }, 90000);

  test("daemon keeps relay socket open while idle (no handshake timeout loop)", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const { logger, lines } = createCapturingLogger();
    await startRelay();

    const daemon = await createTestPaseoDaemon({
      listen: "127.0.0.1",
      logger,
      relayEnabled: true,
      relayEndpoint: `127.0.0.1:${relayPort}`,
    });

    try {
      const offerUrl = await getPairingOfferUrl({
        paseoHome: daemon.paseoHome,
        relayEnabled: daemon.config.relayEnabled,
        relayEndpoint: daemon.config.relayEndpoint,
        relayPublicEndpoint: daemon.config.relayPublicEndpoint,
        appBaseUrl: daemon.config.appBaseUrl,
      });
      const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);

      // Previously, the daemon would time out waiting for `hello` and reconnect every ~10s.
      // Wait long enough to catch that regression.
      await new Promise((r) => setTimeout(r, 12_000));

      const handshakeFailures = lines.filter((line) =>
        line.includes("relay_e2ee_handshake_failed"),
      );
      expect(handshakeFailures.length).toBe(0);

      // Protocol pings (RFC 6455 control frames) are auto-answered at the Cloudflare edge
      // without waking the hibernated relay Durable Object. After 12s, the keepalive interval
      // (10s) must have fired at least once and received a pong. If this assertion fails, the
      // daemon may have regressed to app-level JSON pings (which wake the DO and cost CPU).
      const pongLines = lines.filter((l) => l.includes("relay_control_pong_received"));
      expect(pongLines.length).toBeGreaterThan(0);
      const staleLines = lines.filter((l) => l.includes("relay_control_stale_terminating"));
      expect(staleLines.length).toBe(0);
      // Guard against the dual-ping regression: if a JSON {type:"ping"} reaches the DO during
      // the idle window, the DO logs `legacy_json_ping_received`. The current daemon code must
      // not send JSON pings on the control socket — only protocol pings via socket.ping().
      const legacyPingLines = relayStdoutLines.filter((l) =>
        l.includes("legacy_json_ping_received"),
      );
      expect(legacyPingLines.length).toBe(0);

      const ws = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relayPort}`,
          useTls: false,
          serverId,
          role: "client",
        }),
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

        ws.on("message", (data, isBinary) => {
          transport.onmessage?.({
            data: isBinary
              ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
              : data.toString(),
            isBinary,
          });
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
                const wsMsg = WSOutboundMessageSchema.safeParse(payload);
                if (
                  wsMsg.success &&
                  wsMsg.data.type === "session" &&
                  wsMsg.data.message.type === "status" &&
                  wsMsg.data.message.payload?.status === "server_info"
                ) {
                  if (!pingSent && channelRef) {
                    pingSent = true;
                    void channelRef.send(JSON.stringify({ type: "ping" }));
                  }
                  return;
                }
                if (wsMsg.success && wsMsg.data.type === "pong") {
                  clearTimeout(timeout);
                  resolve(wsMsg.data);
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
              }),
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
  }, 90000);

  test("daemon accepts a relay client that pipelines app hello after E2EE hello", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const { logger, lines } = createCapturingLogger();
    await startRelay();

    const daemon = await createTestPaseoDaemon({
      listen: "127.0.0.1",
      logger,
      relayEnabled: true,
      relayEndpoint: `127.0.0.1:${relayPort}`,
    });

    try {
      const offerUrl = await getPairingOfferUrl({
        paseoHome: daemon.paseoHome,
        relayEnabled: daemon.config.relayEnabled,
        relayEndpoint: daemon.config.relayEndpoint,
        relayPublicEndpoint: daemon.config.relayPublicEndpoint,
        appBaseUrl: daemon.config.appBaseUrl,
      });
      const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);
      const clientKeyPair = generateKeyPair();
      const sharedKey = deriveSharedKey(
        clientKeyPair.secretKey,
        importPublicKey(daemonPublicKeyB64),
      );

      const ws = new WebSocket(
        buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relayPort}`,
          useTls: false,
          serverId,
          role: "client",
        }),
      );

      const received = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error("timed out waiting for server_info"));
        }, 20000);

        const settleResolve = (value: unknown) => {
          clearTimeout(timeout);
          resolve(value);
          ws.close();
        };
        const settleReject = (reason: unknown) => {
          clearTimeout(timeout);
          reject(reason);
          ws.close();
        };

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              type: "e2ee_hello",
              key: exportPublicKey(clientKeyPair.publicKey),
            }),
          );
          ws.send(
            encodeCiphertext(
              encrypt(
                sharedKey,
                JSON.stringify({
                  type: "hello",
                  clientId: "cid_relay_pipelined_hello",
                  clientType: "cli",
                  protocolVersion: 1,
                }),
              ),
            ),
          );
        });

        ws.on("message", (data) => {
          try {
            const text = typeof data === "string" ? data : data.toString();
            const maybePlaintext = JSON.parse(text) as unknown;
            if (
              maybePlaintext &&
              typeof maybePlaintext === "object" &&
              "type" in maybePlaintext &&
              maybePlaintext.type === "e2ee_ready"
            ) {
              return;
            }
          } catch {
            // encrypted frame; parse below
          }

          try {
            const parsed = WSOutboundMessageSchema.parse(
              parseEncryptedJson(sharedKey, data.toString()),
            );
            if (
              parsed.type === "session" &&
              parsed.message.type === "status" &&
              parsed.message.payload?.status === "server_info"
            ) {
              settleResolve({
                type: parsed.type,
                message: {
                  type: parsed.message.type,
                  payload: { status: parsed.message.payload.status },
                },
              });
            }
          } catch (error) {
            settleReject(error);
          }
        });

        ws.on("close", (code, reason) => {
          settleReject(new Error(`relay client closed before server_info: ${code} ${reason}`));
        });
        ws.on("error", (err) => {
          settleReject(err);
        });
      });

      expect(received).toEqual({
        type: "session",
        message: {
          type: "status",
          payload: { status: "server_info" },
        },
      });
    } catch (err) {
      const tail = lines.slice(-50).join("");
      // eslint-disable-next-line no-console
      console.error("daemon logs (tail):\n", tail);
      throw err;
    } finally {
      await daemon.close();
      await stopRelay();
    }
  }, 90000);

  test("reads a workspace file over the E2EE relay session byte-for-byte", async () => {
    process.env.PASEO_PRIMARY_LAN_IP = "192.168.1.12";

    const { logger, lines } = createCapturingLogger();
    let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | null = null;
    let workspaceDir: string | null = null;
    const fileName = "rapport données.bin";
    const source = randomBytes(4 * FILE_EXPLORER_STREAM_CHUNK_BYTES + 123);
    let client: DaemonClient | null = null;

    try {
      await startRelay({ useLocalRelay: true });
      daemon = await createTestPaseoDaemon({
        listen: "127.0.0.1",
        logger,
        relayEnabled: true,
        relayEndpoint: `127.0.0.1:${relayPort}`,
      });
      workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paseo-relay-download-"));
      await writeFile(path.join(workspaceDir, fileName), source);
      const offerUrl = await getPairingOfferUrl({
        paseoHome: daemon.paseoHome,
        relayEnabled: daemon.config.relayEnabled,
        relayEndpoint: daemon.config.relayEndpoint,
        relayPublicEndpoint: daemon.config.relayPublicEndpoint,
        appBaseUrl: daemon.config.appBaseUrl,
      });
      const { serverId, daemonPublicKeyB64 } = decodeOfferFromFragmentUrl(offerUrl);

      client = new DaemonClient({
        url: buildRelayWebSocketUrl({
          endpoint: `127.0.0.1:${relayPort}`,
          useTls: false,
          serverId,
          role: "client",
        }),
        clientType: "cli",
        connectTimeoutMs: 30_000,
        e2ee: { enabled: true, daemonPublicKeyB64 },
        reconnect: { enabled: false },
      });
      await client.connect();

      const result = await client.readFile(workspaceDir, fileName, undefined, undefined, 0);

      expect(result.size).toBe(source.byteLength);
      expect(result.bytes.byteLength).toBe(source.byteLength);
      expect(sha256(result.bytes)).toBe(sha256(source));
    } catch (err) {
      const tail = lines.slice(-50).join("");
      // eslint-disable-next-line no-console
      console.error("daemon logs (tail):\n", tail);
      throw err;
    } finally {
      await client?.close().catch(() => undefined);
      await daemon?.close();
      await stopRelay();
      if (workspaceDir) {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }
  }, 90000);
});

async function openConnectedHostTerminal(origin: HostClient, serverId: string, terminalId: string) {
  const routeId = await origin.openHostRoute(serverId, crypto.randomUUID());
  const messages: SessionOutboundMessage[] = [];
  let output = "";
  const detachBinary = origin.subscribeHostFrames((routed) => {
    if (routed.routeId !== routeId) return;
    const frame = decodeTerminalStreamFrame(routed.payload);
    if (frame?.opcode === TerminalStreamOpcode.Output)
      output += new TextDecoder().decode(frame.payload);
  });
  const detach = origin.subscribeRawMessages((message) => {
    if (message.type !== "hosts.route.frame" || message.payload.subscriptionId !== routeId) return;
    const frame = WSOutboundMessageSchema.parse(JSON.parse(message.payload.data));
    if (frame.type === "session") messages.push(frame.message);
  });
  const close = () => {
    detach();
    detachBinary();
    origin.closeHostRoute(routeId);
  };
  try {
    origin.sendHostFrame(
      routeId,
      JSON.stringify({
        type: "hello",
        clientId: "relay-binary",
        clientType: "cli",
        protocolVersion: 1,
      }),
    );
    await expect
      .poll(() =>
        messages.some(
          (message) => message.type === "status" && message.payload.status === "server_info",
        ),
      )
      .toBe(true);
    origin.sendHostFrame(
      routeId,
      JSON.stringify({
        type: "session",
        message: { type: "subscribe_terminal_request", terminalId, requestId: "binary" },
      }),
    );
    await expect
      .poll(() => messages.some((message) => message.type === "subscribe_terminal_response"))
      .toBe(true);
    const response = messages.find((message) => message.type === "subscribe_terminal_response");
    if (response?.type !== "subscribe_terminal_response" || response.payload.slot == null)
      throw new Error("Missing binary stream slot");
    const slot = response.payload.slot;
    return {
      close,
      output: () => output,
      write: (payload: string) =>
        origin.sendHostFrame(
          routeId,
          encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Input, slot, payload }),
        ),
    };
  } catch (error) {
    close();
    throw error;
  }
}

async function relayWire(relayPort: number) {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  let active = 0;
  const server = net.createServer((source) => {
    const target = net.connect(relayPort, "127.0.0.1");
    sockets.add(source);
    sockets.add(target);
    let counted = false;
    target.on("connect", () => {
      counted = true;
      connections++;
      active++;
    });
    target.on("error", () => source.destroy());
    source.on("error", () => target.destroy());
    target.on("close", () => {
      if (counted) active--;
      sockets.delete(target);
      source.destroy();
    });
    source.on("close", () => {
      sockets.delete(source);
      target.destroy();
    });
    source.pipe(target);
    target.pipe(source);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing relay wire port");
  return {
    port: address.port,
    connections: () => connections,
    active: () => active,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
