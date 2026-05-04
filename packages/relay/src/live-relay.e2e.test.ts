import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

const RELAY_BASE_URL = "wss://relay.paseo.sh";

async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries: number; delayMs: number },
): Promise<T> {
  async function attempt(attemptNumber: number, lastError: unknown): Promise<T> {
    if (attemptNumber > options.retries) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    try {
      return await fn();
    } catch (error) {
      if (attemptNumber < options.retries) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      return attempt(attemptNumber + 1, error);
    }
  }
  return attempt(0, null);
}

function waitOpen(ws: WebSocket, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out opening ${label} websocket`)),
      10_000,
    );
    const onOpen = () => {
      clearTimeout(timeout);
      resolve();
    };
    const onError = (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function waitForConnected(ws: WebSocket, connectionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for connected")), 10_000);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.type === "connected" && msg.connectionId === connectionId) {
          clearTimeout(timeout);
          resolve();
        }
      } catch {
        // ignore
      }
    };
    ws.on("message", onMessage);
  });
}

function waitForOnceMessage<T extends "string" | "buffer">(
  ws: WebSocket,
  mode: T,
  timeoutError: string,
): Promise<T extends "string" ? string : Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(timeoutError)), 10_000);
    const onMessage = (data: WebSocket.RawData) => {
      clearTimeout(timeout);
      resolve(
        (mode === "string" ? data.toString() : (data as Buffer)) as T extends "string"
          ? string
          : Buffer,
      );
    };
    ws.once("message", onMessage);
  });
}

describe("Live relay (relay.paseo.sh) E2E", () => {
  const liveIt = process.env.RUN_LIVE_RELAY_E2E === "1" ? it : it.skip;

  liveIt("bridges encrypted traffic end-to-end", { timeout: 45_000 }, async () => {
    await withRetry(
      async () => {
        const serverId = `live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const connectionId = `clt_live_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const serverControlUrl = `${RELAY_BASE_URL}/ws?serverId=${encodeURIComponent(serverId)}&role=server&v=2`;
        const serverDataUrl = `${RELAY_BASE_URL}/ws?serverId=${encodeURIComponent(
          serverId,
        )}&role=server&connectionId=${encodeURIComponent(connectionId)}&v=2`;
        const clientUrl = `${RELAY_BASE_URL}/ws?serverId=${encodeURIComponent(
          serverId,
        )}&role=client&connectionId=${encodeURIComponent(connectionId)}&v=2`;

        // === Key setup ===
        const daemonKeyPair = generateKeyPair();
        const daemonPubKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

        const clientKeyPair = generateKeyPair();
        const clientPubKeyB64 = exportPublicKey(clientKeyPair.publicKey);

        const daemonPubKeyOnClient = importPublicKey(daemonPubKeyB64);
        const clientSharedKey = deriveSharedKey(clientKeyPair.secretKey, daemonPubKeyOnClient);

        // === Connect ===
        const daemonControlWs = new WebSocket(serverControlUrl);
        const clientWs = new WebSocket(clientUrl);
        let daemonWs: WebSocket | null = null;

        try {
          await Promise.all([
            waitOpen(daemonControlWs, "server-control"),
            waitOpen(clientWs, "client"),
          ]);

          await waitForConnected(daemonControlWs, connectionId);

          daemonWs = new WebSocket(serverDataUrl);
          await waitOpen(daemonWs, "server-data");

          // === Handshake ===
          // Client sends hello with its public key (not encrypted).
          clientWs.send(JSON.stringify({ type: "hello", key: clientPubKeyB64 }));

          const daemonReceivedHello = await waitForOnceMessage(
            daemonWs,
            "string",
            "Timed out waiting for hello",
          );

          const hello = JSON.parse(daemonReceivedHello) as {
            type: string;
            key?: string;
          };
          expect(hello.type).toBe("hello");
          expect(typeof hello.key).toBe("string");

          const clientPubKeyOnDaemon = importPublicKey(hello.key!);
          const daemonSharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPubKeyOnDaemon);

          // === Encrypted exchange ===
          const plaintextFromClient = "hello-from-client";
          const ciphertextFromClient = encrypt(clientSharedKey, plaintextFromClient);
          clientWs.send(Buffer.from(ciphertextFromClient));

          const daemonReceivedCiphertext = await waitForOnceMessage(
            daemonWs,
            "buffer",
            "Timed out waiting for encrypted message",
          );

          const decryptedOnDaemon = decrypt(
            daemonSharedKey,
            daemonReceivedCiphertext.buffer.slice(
              daemonReceivedCiphertext.byteOffset,
              daemonReceivedCiphertext.byteOffset + daemonReceivedCiphertext.byteLength,
            ),
          );
          expect(decryptedOnDaemon).toBe(plaintextFromClient);

          const plaintextFromDaemon = "hello-from-daemon";
          const ciphertextFromDaemon = encrypt(daemonSharedKey, plaintextFromDaemon);
          daemonWs.send(Buffer.from(ciphertextFromDaemon));

          const clientReceivedCiphertext = await waitForOnceMessage(
            clientWs,
            "buffer",
            "Timed out waiting for encrypted response",
          );

          const decryptedOnClient = decrypt(
            clientSharedKey,
            clientReceivedCiphertext.buffer.slice(
              clientReceivedCiphertext.byteOffset,
              clientReceivedCiphertext.byteOffset + clientReceivedCiphertext.byteLength,
            ),
          );
          expect(decryptedOnClient).toBe(plaintextFromDaemon);
        } finally {
          daemonControlWs.close();
          daemonWs?.close();
          clientWs.close();
        }
      },
      { retries: 2, delayMs: 250 },
    );
  });
});
