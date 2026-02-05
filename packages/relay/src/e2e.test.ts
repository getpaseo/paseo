import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, type RelayServer } from "./node-adapter.js";
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

const TEST_PORT = 19999;

describe("E2E Relay with E2EE", () => {
  let relay: RelayServer;

  beforeAll(async () => {
    relay = createRelayServer({ port: TEST_PORT, host: "127.0.0.1" });
    await relay.start();
  });

  afterAll(async () => {
    await relay.stop();
  });

  it("full flow: daemon and client exchange encrypted messages through relay", async () => {
    const serverId = "test-session-" + Date.now();
    const clientId = "clt_test_" + Date.now() + "_" + Math.random().toString(36).slice(2);

    // === DAEMON SIDE ===
    // Generate keypair (public key goes in QR)
    const daemonKeyPair = await generateKeyPair();
    const daemonPubKeyB64 = await exportPublicKey(daemonKeyPair.publicKey);

    // QR would contain: { serverId, daemonPubKeyB64, relay: { endpoint } }

    // Daemon connects to relay as "server" control role
    const daemonControlWs = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?serverId=${serverId}&role=server`
    );

    await new Promise<void>((resolve, reject) => {
      daemonControlWs.on("open", resolve);
      daemonControlWs.on("error", reject);
    });

    // === CLIENT SIDE ===
    // Client scans QR, gets daemon's public key and session ID
    // Client generates own keypair
    const clientKeyPair = await generateKeyPair();
    const clientPubKeyB64 = await exportPublicKey(clientKeyPair.publicKey);

    // Client imports daemon's public key and derives shared secret
    const daemonPubKeyOnClient = await importPublicKey(daemonPubKeyB64);
    const clientSharedKey = await deriveSharedKey(
      clientKeyPair.secretKey,
      daemonPubKeyOnClient
    );

    // Client connects to relay as "client" role (must include clientId in v2)
    const clientWs = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?serverId=${serverId}&role=client&clientId=${clientId}`
    );

    await new Promise<void>((resolve, reject) => {
      clientWs.on("open", resolve);
      clientWs.on("error", reject);
    });

    // Wait for relay to notify daemon control socket, then open the per-client server-data socket.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for client_connected")), 5000);
      daemonControlWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type === "client_connected" && msg.clientId === clientId) {
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          // ignore
        }
      });
    });

    const daemonWs = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?serverId=${serverId}&role=server&clientId=${clientId}`
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
    const clientPubKeyOnDaemon = await importPublicKey(hello.key);
    const daemonSharedKey = await deriveSharedKey(
      daemonKeyPair.secretKey,
      clientPubKeyOnDaemon
    );

    // === VERIFY BOTH HAVE SAME KEY - Exchange encrypted messages ===

    // Daemon sends encrypted "ready" message
    const readyPlaintext = JSON.stringify({ type: "ready" });
    const readyCiphertext = await encrypt(daemonSharedKey, readyPlaintext);
    daemonWs.send(Buffer.from(readyCiphertext));

    // Client receives and decrypts
    const clientReceivedReady = await new Promise<Buffer>((resolve) => {
      clientWs.once("message", (data) => resolve(data as Buffer));
    });
    const decryptedReady = await decrypt(
      clientSharedKey,
      clientReceivedReady.buffer.slice(
        clientReceivedReady.byteOffset,
        clientReceivedReady.byteOffset + clientReceivedReady.byteLength
      )
    );
    expect(JSON.parse(decryptedReady as string)).toEqual({ type: "ready" });

    // Client sends encrypted message
    const clientMessage = "Hello from client!";
    const clientCiphertext = await encrypt(clientSharedKey, clientMessage);
    clientWs.send(Buffer.from(clientCiphertext));

    // Daemon receives and decrypts
    const daemonReceivedMsg = await new Promise<Buffer>((resolve) => {
      daemonWs.once("message", (data) => resolve(data as Buffer));
    });
    const decryptedClientMsg = await decrypt(
      daemonSharedKey,
      daemonReceivedMsg.buffer.slice(
        daemonReceivedMsg.byteOffset,
        daemonReceivedMsg.byteOffset + daemonReceivedMsg.byteLength
      )
    );
    expect(decryptedClientMsg).toBe(clientMessage);

    // Daemon sends encrypted response
    const daemonMessage = "Hello from daemon!";
    const daemonCiphertext = await encrypt(daemonSharedKey, daemonMessage);
    daemonWs.send(Buffer.from(daemonCiphertext));

    // Client receives and decrypts
    const clientReceivedMsg = await new Promise<Buffer>((resolve) => {
      clientWs.once("message", (data) => resolve(data as Buffer));
    });
    const decryptedDaemonMsg = await decrypt(
      clientSharedKey,
      clientReceivedMsg.buffer.slice(
        clientReceivedMsg.byteOffset,
        clientReceivedMsg.byteOffset + clientReceivedMsg.byteLength
      )
    );
    expect(decryptedDaemonMsg).toBe(daemonMessage);

    // Cleanup
    daemonWs.close();
    clientWs.close();
  });

  it("relay only sees opaque bytes after handshake", async () => {
    const serverId = "opaque-test-" + Date.now();
    const clientId = "clt_opaque_" + Date.now() + "_" + Math.random().toString(36).slice(2);

    // Setup keys
    const daemonKeyPair = await generateKeyPair();
    const clientKeyPair = await generateKeyPair();

    const daemonPubKeyB64 = await exportPublicKey(daemonKeyPair.publicKey);
    const clientPubKeyB64 = await exportPublicKey(clientKeyPair.publicKey);

    const clientPubKey = await importPublicKey(clientPubKeyB64);
    const daemonPubKey = await importPublicKey(daemonPubKeyB64);

    const daemonSharedKey = await deriveSharedKey(
      daemonKeyPair.secretKey,
      clientPubKey
    );
    const clientSharedKey = await deriveSharedKey(
      clientKeyPair.secretKey,
      daemonPubKey
    );

    const daemonControlWs = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?serverId=${serverId}&role=server`
    );
    await new Promise<void>((r) => daemonControlWs.on("open", r));

    const waitForClientSeen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for client_connected")),
        5000
      );
      const onMessage = (raw: unknown) => {
        try {
          const text =
            typeof raw === "string"
              ? raw
              : raw && typeof (raw as any).toString === "function"
                ? (raw as any).toString()
                : "";
          const msg = JSON.parse(text);
          if (msg?.type === "client_connected" && msg.clientId === clientId) {
            clearTimeout(timeout);
            daemonControlWs.off("message", onMessage);
            resolve();
            return;
          }
          if (msg?.type === "sync" && Array.isArray(msg.clientIds) && msg.clientIds.includes(clientId)) {
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
      `ws://127.0.0.1:${TEST_PORT}/ws?serverId=${serverId}&role=client&clientId=${clientId}`
    );
    await new Promise<void>((r) => clientWs.on("open", r));
    await waitForClientSeen;

    const daemonWs = new WebSocket(
      `ws://127.0.0.1:${TEST_PORT}/ws?serverId=${serverId}&role=server&clientId=${clientId}`
    );
    await new Promise<void>((r) => daemonWs.on("open", r));

    // Handshake (not encrypted)
    clientWs.send(JSON.stringify({ type: "hello", key: clientPubKeyB64 }));
    await new Promise<void>((resolve) => {
      daemonWs.once("message", () => resolve());
    });

    // Send encrypted secret
    const secret = "This is a secret that relay cannot read";
    const ciphertext = await encrypt(clientSharedKey, secret);
    clientWs.send(Buffer.from(ciphertext));

    // Daemon receives
    const received = await new Promise<Buffer>((resolve) => {
      daemonWs.once("message", (data) => resolve(data as Buffer));
    });

    // The raw bytes don't contain the plaintext
    const rawString = received.toString("utf-8");
    expect(rawString).not.toContain(secret);

    // But daemon can decrypt
    const decrypted = await decrypt(
      daemonSharedKey,
      received.buffer.slice(
        received.byteOffset,
        received.byteOffset + received.byteLength
      )
    );
    expect(decrypted).toBe(secret);

    daemonControlWs.close();
    daemonWs.close();
    clientWs.close();
  });

  it("wrong key cannot decrypt", async () => {
    const serverId = "wrong-key-test-" + Date.now();

    // Setup - daemon and client with correct keys
    const daemonKeyPair = await generateKeyPair();
    const clientKeyPair = await generateKeyPair();
    const attackerKeyPair = await generateKeyPair();

    const clientPubKey = await importPublicKey(
      await exportPublicKey(clientKeyPair.publicKey)
    );
    const daemonSharedKey = await deriveSharedKey(
      daemonKeyPair.secretKey,
      clientPubKey
    );

    // Attacker tries to derive key with their own keypair
    const attackerPubKey = await importPublicKey(
      await exportPublicKey(attackerKeyPair.publicKey)
    );
    const attackerKey = await deriveSharedKey(
      attackerKeyPair.secretKey,
      attackerPubKey
    );

    // Encrypt with daemon's key
    const secret = "Top secret message";
    const ciphertext = await encrypt(daemonSharedKey, secret);

    // Attacker cannot decrypt
    expect(() => decrypt(attackerKey, ciphertext)).toThrow();
  });
});
