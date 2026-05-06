import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

const nodeMajor = Number((process.versions.node ?? "0").split(".")[0] ?? "0");
const shouldRunRelayE2e = process.env.FORCE_RELAY_E2E === "1" || nodeMajor < 25;
const wranglerCliPath = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
const STARTUP_HOOK_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function rawToText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof (raw as { toString?: unknown }).toString === "function") {
    return (raw as { toString(): string }).toString();
  }
  return "";
}

function spawnRelayDevServer(port: number): ChildProcess {
  return spawn(
    process.execPath,
    [
      wranglerCliPath,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--live-reload=false",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );
}

function assertRelayStillRunning(relayProcess: ChildProcess): void {
  if (relayProcess.exitCode !== null) {
    throw new Error(
      `relay process exited before startup completed (code: ${relayProcess.exitCode})`,
    );
  }
}

function tryConnect(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

async function waitForServer(
  port: number,
  relayProcess: ChildProcess,
  timeout = 15000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  async function poll(): Promise<void> {
    if (Date.now() >= deadline) {
      throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
    }
    assertRelayStillRunning(relayProcess);
    try {
      await tryConnect(port);
      return;
    } catch {
      await sleep(100);
      return poll();
    }
  }
  return poll();
}

function probeRelayWebSocket(port: number): Promise<boolean> {
  const serverId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const probeUrl = `ws://127.0.0.1:${port}/ws?serverId=${serverId}&role=server&v=2`;
  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(probeUrl);
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      settle(false);
    }, 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close(1000, "probe");
      settle(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      settle(false);
    });
  });
}

async function waitForRelayWebSocketReady(
  port: number,
  relayProcess: ChildProcess,
  timeout = 60000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  async function poll(): Promise<void> {
    if (Date.now() >= deadline) {
      throw new Error(`Relay WebSocket endpoint not ready on port ${port} within ${timeout}ms`);
    }
    assertRelayStillRunning(relayProcess);
    const opened = await probeRelayWebSocket(port);
    if (opened) return;
    await sleep(250);
    return poll();
  }
  return poll();
}

async function waitForProcessExit(relayProcess: ChildProcess, deadline: number): Promise<void> {
  if (relayProcess.exitCode !== null) return;
  if (Date.now() >= deadline) return;
  await sleep(50);
  return waitForProcessExit(relayProcess, deadline);
}

async function stopRelayProcess(relayProcess: ChildProcess): Promise<void> {
  if (relayProcess.exitCode !== null) {
    return;
  }

  relayProcess.kill("SIGTERM");
  await waitForProcessExit(relayProcess, Date.now() + SHUTDOWN_TIMEOUT_MS);

  if (relayProcess.exitCode !== null) {
    return;
  }

  relayProcess.kill("SIGKILL");
  await waitForProcessExit(relayProcess, Date.now() + 2000);

  if (relayProcess.exitCode === null) {
    throw new Error("relay process did not exit after SIGTERM/SIGKILL");
  }
}

(shouldRunRelayE2e ? describe : describe.skip)("E2E Relay with E2EE", () => {
  let relayPort: number;
  let relayProcess: ChildProcess | null = null;

  beforeAll(async () => {
    relayPort = await getAvailablePort();
    relayProcess = spawnRelayDevServer(relayPort);

    const hasContent = (line: string) => line.trim().length > 0;
    relayProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(hasContent);
      for (const line of lines) {
        // eslint-disable-next-line no-console
        console.log(`[relay] ${line}`);
      }
    });
    relayProcess.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(hasContent);
      for (const line of lines) {
        // eslint-disable-next-line no-console
        console.error(`[relay] ${line}`);
      }
    });

    try {
      await waitForServer(relayPort, relayProcess, 30000);
      await waitForRelayWebSocketReady(relayPort, relayProcess, 60000);
    } catch (error) {
      await stopRelayProcess(relayProcess);
      relayProcess = null;
      throw error;
    }
  }, STARTUP_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (relayProcess) {
      await stopRelayProcess(relayProcess);
      relayProcess = null;
    }
  }, SHUTDOWN_TIMEOUT_MS);

  it(
    "full flow: daemon and client exchange encrypted messages through relay",
    {
      timeout: 90_000,
    },
    async () => {
      const serverId = "test-session-" + Date.now();
      const connectionId = "clt_test_" + Date.now() + "_" + Math.random().toString(36).slice(2);

      // === DAEMON SIDE ===
      // Generate keypair (public key goes in QR)
      const daemonKeyPair = generateKeyPair();
      const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

      // QR would contain: { serverId, daemonPubKeyB64, relay: { endpoint } }

      // Daemon connects to relay as "server" control role
      const daemonControlWs = new WebSocket(
        `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=server&v=2`,
      );

      await new Promise<void>((resolve, reject) => {
        daemonControlWs.on("open", resolve);
        daemonControlWs.on("error", reject);
      });

      // === CLIENT SIDE ===
      // Client scans QR, gets daemon's public key and session ID
      // Client generates own keypair
      const clientKeyPair = generateKeyPair();
      const clientPubKeyB64 = exportPublicKey(clientKeyPair.publicKey);

      // Client imports daemon's public key and derives shared secret
      const daemonPubKeyOnClient = importPublicKey(daemonPubKeyB64);
      const clientSharedKey = deriveSharedKey(clientKeyPair.secretKey, daemonPubKeyOnClient);

      const waitForClientSeen = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for connected")),
          5000,
        );
        const onMessage = (raw: unknown) => {
          try {
            const text = rawToText(raw);
            const msg = JSON.parse(text);
            if (msg?.type === "connected" && msg.connectionId === connectionId) {
              clearTimeout(timeout);
              daemonControlWs.off("message", onMessage);
              resolve();
              return;
            }
            if (
              msg?.type === "sync" &&
              Array.isArray(msg.connectionIds) &&
              msg.connectionIds.includes(connectionId)
            ) {
              clearTimeout(timeout);
              daemonControlWs.off("message", onMessage);
              resolve();
            }
          } catch {
            // ignore
          }
        };
        daemonControlWs.on("message", onMessage);
      });

      // Client connects to relay as "client" role (must include connectionId)
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=client&connectionId=${connectionId}&v=2`,
      );

      await new Promise<void>((resolve, reject) => {
        clientWs.on("open", resolve);
        clientWs.on("error", reject);
      });

      await waitForClientSeen;

      const daemonWs = new WebSocket(
        `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=server&connectionId=${connectionId}&v=2`,
      );
      await new Promise<void>((resolve, reject) => {
        daemonWs.on("open", resolve);
        daemonWs.on("error", reject);
      });

      // Client sends hello with its public key (this message is NOT encrypted - it's the handshake)
      const helloMsg = JSON.stringify({ type: "hello", key: clientPubKeyB64 });
      clientWs.send(helloMsg);

      // === DAEMON RECEIVES HELLO ===
      const daemonReceivedHello = await new Promise<string>((resolve) => {
        daemonWs.once("message", (data) => resolve(data.toString()));
      });

      const hello = JSON.parse(daemonReceivedHello);
      expect(hello.type).toBe("hello");
      expect(hello.key).toBe(clientPubKeyB64);

      // Daemon imports client's public key and derives shared secret
      const clientPubKeyOnDaemon = importPublicKey(hello.key);
      const daemonSharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPubKeyOnDaemon);

      // === VERIFY BOTH HAVE SAME KEY - Exchange encrypted messages ===

      // Daemon sends encrypted "ready" message
      const readyPlaintext = JSON.stringify({ type: "ready" });
      const readyCiphertext = encrypt(daemonSharedKey, readyPlaintext);
      daemonWs.send(Buffer.from(readyCiphertext));

      // Client receives and decrypts
      const clientReceivedReady = await new Promise<Buffer>((resolve) => {
        clientWs.once("message", (data) => resolve(data as Buffer));
      });
      const decryptedReady = decrypt(
        clientSharedKey,
        clientReceivedReady.buffer.slice(
          clientReceivedReady.byteOffset,
          clientReceivedReady.byteOffset + clientReceivedReady.byteLength,
        ),
      );
      expect(JSON.parse(decryptedReady as string)).toEqual({ type: "ready" });

      // Client sends encrypted message
      const clientMessage = "Hello from client!";
      const clientCiphertext = encrypt(clientSharedKey, clientMessage);
      clientWs.send(Buffer.from(clientCiphertext));

      // Daemon receives and decrypts
      const daemonReceivedMsg = await new Promise<Buffer>((resolve) => {
        daemonWs.once("message", (data) => resolve(data as Buffer));
      });
      const decryptedClientMsg = decrypt(
        daemonSharedKey,
        daemonReceivedMsg.buffer.slice(
          daemonReceivedMsg.byteOffset,
          daemonReceivedMsg.byteOffset + daemonReceivedMsg.byteLength,
        ),
      );
      expect(decryptedClientMsg).toBe(clientMessage);

      // Daemon sends encrypted response
      const daemonMessage = "Hello from daemon!";
      const daemonCiphertext = encrypt(daemonSharedKey, daemonMessage);
      daemonWs.send(Buffer.from(daemonCiphertext));

      // Client receives and decrypts
      const clientReceivedMsg = await new Promise<Buffer>((resolve) => {
        clientWs.once("message", (data) => resolve(data as Buffer));
      });
      const decryptedDaemonMsg = decrypt(
        clientSharedKey,
        clientReceivedMsg.buffer.slice(
          clientReceivedMsg.byteOffset,
          clientReceivedMsg.byteOffset + clientReceivedMsg.byteLength,
        ),
      );
      expect(decryptedDaemonMsg).toBe(daemonMessage);

      // Cleanup
      daemonWs.close();
      clientWs.close();
    },
  );

  it("relay only sees opaque bytes after handshake", { timeout: 90_000 }, async () => {
    const serverId = "opaque-test-" + Date.now();
    const connectionId = "clt_opaque_" + Date.now() + "_" + Math.random().toString(36).slice(2);

    // Setup keys
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();

    const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);
    const clientPubKeyB64 = exportPublicKey(clientKeyPair.publicKey);

    const clientPubKey = importPublicKey(clientPubKeyB64);
    const daemonPubKey = importPublicKey(daemonPubKeyB64);

    const daemonSharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPubKey);
    const clientSharedKey = deriveSharedKey(clientKeyPair.secretKey, daemonPubKey);

    const daemonControlWs = new WebSocket(
      `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=server&v=2`,
    );
    await new Promise<void>((r) => daemonControlWs.on("open", r));

    const waitForClientSeen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for connected")), 5000);
      const onMessage = (raw: unknown) => {
        try {
          const text = rawToText(raw);
          const msg = JSON.parse(text);
          if (msg?.type === "connected" && msg.connectionId === connectionId) {
            clearTimeout(timeout);
            daemonControlWs.off("message", onMessage);
            resolve();
            return;
          }
          if (
            msg?.type === "sync" &&
            Array.isArray(msg.connectionIds) &&
            msg.connectionIds.includes(connectionId)
          ) {
            clearTimeout(timeout);
            daemonControlWs.off("message", onMessage);
            resolve();
          }
        } catch {
          // ignore
        }
      };
      daemonControlWs.on("message", onMessage);
    });

    const clientWs = new WebSocket(
      `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=client&connectionId=${connectionId}&v=2`,
    );
    await new Promise<void>((r) => clientWs.on("open", r));
    await waitForClientSeen;

    const daemonWs = new WebSocket(
      `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=server&connectionId=${connectionId}&v=2`,
    );
    await new Promise<void>((r) => daemonWs.on("open", r));

    // Handshake (not encrypted)
    clientWs.send(JSON.stringify({ type: "hello", key: clientPubKeyB64 }));
    await new Promise<void>((resolve) => {
      daemonWs.once("message", () => resolve());
    });

    // Send encrypted secret
    const secret = "This is a secret that relay cannot read";
    const ciphertext = encrypt(clientSharedKey, secret);
    clientWs.send(Buffer.from(ciphertext));

    // Daemon receives
    const received = await new Promise<Buffer>((resolve) => {
      daemonWs.once("message", (data) => resolve(data as Buffer));
    });

    // The raw bytes don't contain the plaintext
    const rawString = received.toString("utf-8");
    expect(rawString).not.toContain(secret);

    // But daemon can decrypt
    const decrypted = decrypt(
      daemonSharedKey,
      received.buffer.slice(received.byteOffset, received.byteOffset + received.byteLength),
    );
    expect(decrypted).toBe(secret);

    daemonControlWs.close();
    daemonWs.close();
    clientWs.close();
  });

  it("wrong key cannot decrypt", () => {
    // Setup - daemon and client with correct keys
    const daemonKeyPair = generateKeyPair();
    const clientKeyPair = generateKeyPair();
    const attackerKeyPair = generateKeyPair();

    const clientPubKey = importPublicKey(exportPublicKey(clientKeyPair.publicKey));
    const daemonSharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPubKey);

    // Attacker tries to derive key with their own keypair
    const attackerPubKey = importPublicKey(exportPublicKey(attackerKeyPair.publicKey));
    const attackerKey = deriveSharedKey(attackerKeyPair.secretKey, attackerPubKey);

    // Encrypt with daemon's key
    const secret = "Top secret message";
    const ciphertext = encrypt(daemonSharedKey, secret);

    // Attacker cannot decrypt
    expect(() => decrypt(attackerKey, ciphertext)).toThrow();
  });
});
