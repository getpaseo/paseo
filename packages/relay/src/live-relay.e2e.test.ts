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
  options: { retries: number; delayMs: number }
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe("Live relay (relay.paseo.sh) E2E", () => {
  const liveIt = process.env.RUN_LIVE_RELAY_E2E === "1" ? it : it.skip;

  liveIt("bridges encrypted traffic end-to-end", { timeout: 45_000 }, async () => {
    await withRetry(
      async () => {
        const sessionId = `live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const serverUrl = `${RELAY_BASE_URL}/ws?serverId=${encodeURIComponent(sessionId)}&role=server`;
        const clientUrl = `${RELAY_BASE_URL}/ws?serverId=${encodeURIComponent(sessionId)}&role=client`;

        // === Key setup ===
        const daemonKeyPair = await generateKeyPair();
        const daemonPubKeyB64 = await exportPublicKey(daemonKeyPair.publicKey);

        const clientKeyPair = await generateKeyPair();
        const clientPubKeyB64 = await exportPublicKey(clientKeyPair.publicKey);

        const daemonPubKeyOnClient = await importPublicKey(daemonPubKeyB64);
        const clientSharedKey = await deriveSharedKey(
          clientKeyPair.secretKey,
          daemonPubKeyOnClient
        );

        // === Connect ===
        const daemonWs = new WebSocket(serverUrl);
        const clientWs = new WebSocket(clientUrl);

        const waitOpen = (ws: WebSocket, label: string) =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error(`Timed out opening ${label} websocket`)),
              10_000
            );
            ws.once("open", () => {
              clearTimeout(timeout);
              resolve();
            });
            ws.once("error", (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });

        try {
          await Promise.all([waitOpen(daemonWs, "server"), waitOpen(clientWs, "client")]);

          // === Handshake ===
          // Client sends hello with its public key (not encrypted).
          clientWs.send(JSON.stringify({ type: "hello", key: clientPubKeyB64 }));

          const daemonReceivedHello = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Timed out waiting for hello")),
              10_000
            );
            daemonWs.once("message", (data) => {
              clearTimeout(timeout);
              resolve(data.toString());
            });
          });

          const hello = JSON.parse(daemonReceivedHello) as {
            type: string;
            key?: string;
          };
          expect(hello.type).toBe("hello");
          expect(typeof hello.key).toBe("string");

          const clientPubKeyOnDaemon = await importPublicKey(hello.key!);
          const daemonSharedKey = await deriveSharedKey(
            daemonKeyPair.secretKey,
            clientPubKeyOnDaemon
          );

          // === Encrypted exchange ===
          const plaintextFromClient = "hello-from-client";
          const ciphertextFromClient = await encrypt(
            clientSharedKey,
            plaintextFromClient
          );
          clientWs.send(Buffer.from(ciphertextFromClient));

          const daemonReceivedCiphertext = await new Promise<Buffer>(
            (resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("Timed out waiting for encrypted message")),
                10_000
              );
              daemonWs.once("message", (data) => {
                clearTimeout(timeout);
                resolve(data as Buffer);
              });
            }
          );

          const decryptedOnDaemon = await decrypt(
            daemonSharedKey,
            daemonReceivedCiphertext.buffer.slice(
              daemonReceivedCiphertext.byteOffset,
              daemonReceivedCiphertext.byteOffset +
                daemonReceivedCiphertext.byteLength
            )
          );
          expect(decryptedOnDaemon).toBe(plaintextFromClient);

          const plaintextFromDaemon = "hello-from-daemon";
          const ciphertextFromDaemon = await encrypt(
            daemonSharedKey,
            plaintextFromDaemon
          );
          daemonWs.send(Buffer.from(ciphertextFromDaemon));

          const clientReceivedCiphertext = await new Promise<Buffer>(
            (resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("Timed out waiting for encrypted response")),
                10_000
              );
              clientWs.once("message", (data) => {
                clearTimeout(timeout);
                resolve(data as Buffer);
              });
            }
          );

          const decryptedOnClient = await decrypt(
            clientSharedKey,
            clientReceivedCiphertext.buffer.slice(
              clientReceivedCiphertext.byteOffset,
              clientReceivedCiphertext.byteOffset +
                clientReceivedCiphertext.byteLength
            )
          );
          expect(decryptedOnClient).toBe(plaintextFromDaemon);
        } finally {
          daemonWs.close();
          clientWs.close();
        }
      },
      { retries: 2, delayMs: 250 }
    );
  });
});
