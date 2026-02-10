/// <reference lib="dom" />
/**
 * Encrypted channel that wraps a WebSocket-like transport.
 *
 * Handles ECDH handshake and encrypts/decrypts all messages.
 * Works identically for daemon and client sides.
 */

import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
  type KeyPair,
  type SharedKey,
} from "./crypto.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";

export interface Transport {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((data: string | ArrayBuffer) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface EncryptedChannelEvents {
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (error: Error) => void;
}

type ChannelState = "connecting" | "handshaking" | "open" | "closed";

type EncryptedChannelOptions = {
  /**
   * If set, the channel can validate repeated plaintext `{type:"hello"}`
   * messages even after it is open.
   *
   * This is useful for robustness when the client retries the handshake
   * (e.g., it didn't observe the daemon's `{type:"ready"}` yet). In that case,
   * the daemon should re-send `{type:"ready"}` without changing keys.
   */
  daemonKeyPair?: KeyPair;
};

interface HelloMessage {
  type: "hello";
  key: string;
}

interface ReadyMessage {
  type: "ready";
}

const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;

/**
 * Creates an encrypted channel as the initiator (client).
 *
 * The client:
 * 1. Receives daemon's public key via QR code
 * 2. Generates own keypair
 * 3. Sends hello with own public key
 * 4. Derives shared key and starts encrypted communication
 */
export async function createClientChannel(
  transport: Transport,
  daemonPublicKeyB64: string,
  events: EncryptedChannelEvents = {}
): Promise<EncryptedChannel> {
  const keyPair = generateKeyPair();
  const daemonPublicKey = importPublicKey(daemonPublicKeyB64);
  const sharedKey = deriveSharedKey(keyPair.secretKey, daemonPublicKey);

  const channel = new EncryptedChannel(transport, sharedKey, events);

  // Send hello with our public key
  const ourPublicKeyB64 = exportPublicKey(keyPair.publicKey);
  const hello: HelloMessage = { type: "hello", key: ourPublicKeyB64 };
  const helloText = JSON.stringify(hello);

  let retry: ReturnType<typeof setInterval> | null = null;
  const emitSendError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    events.onerror?.(err);
  };
  const sendHello = () => {
    try {
      transport.send(helloText);
      return true;
    } catch (error) {
      // This can happen during daemon restarts while the socket transitions
      // through CLOSING/CLOSED states. Report it but do not throw from timers.
      emitSendError(error);
      return false;
    }
  };
  const clearRetry = () => {
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
  };

  channel.onTransitionToOpen(() => clearRetry());
  channel.onClose(() => clearRetry());

  sendHello();
  retry = setInterval(() => {
    if (channel.isOpen()) {
      clearRetry();
      return;
    }
    sendHello();
  }, HANDSHAKE_RETRY_MS);
  // Avoid keeping Node processes alive (e.g. tests) if the handshake is stuck.
  (retry as unknown as { unref?: () => void }).unref?.();

  return channel;
}

/**
 * Creates an encrypted channel as the responder (daemon).
 *
 * The daemon:
 * 1. Has pre-generated keypair (public key was in QR)
 * 2. Waits for client's hello with their public key
 * 3. Derives shared key and starts encrypted communication
 */
export async function createDaemonChannel(
  transport: Transport,
  daemonKeyPair: KeyPair,
  events: EncryptedChannelEvents = {}
): Promise<EncryptedChannel> {
  return new Promise((resolve, reject) => {
    const bufferedMessages: Array<string | ArrayBuffer> = [];
    const shouldIgnorePostHelloPlaintext = (data: string | ArrayBuffer): boolean => {
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parsed = JSON.parse(text) as Partial<HelloMessage | ReadyMessage>;
        return parsed.type === "hello" || parsed.type === "ready";
      } catch {
        return false;
      }
    };

    transport.onmessage = async (data) => {
      try {
        const helloText =
          typeof data === "string" ? data : new TextDecoder().decode(data);

        const msg = JSON.parse(helloText) as HelloMessage;
        if (msg.type !== "hello" || !msg.key) {
          throw new Error("Invalid hello message");
        }

        // Buffer any subsequent messages that arrive while we're doing async
        // WebCrypto work to derive the shared key. Without this, it's possible
        // for the next message (already encrypted) to be misinterpreted as a
        // second hello, causing the handshake to fail.
        transport.onmessage = (next) => {
          bufferedMessages.push(next);
        };

        const clientPublicKey = importPublicKey(msg.key);
        const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPublicKey);

        const channel = new EncryptedChannel(transport, sharedKey, events, { daemonKeyPair });
        transport.send(JSON.stringify({ type: "ready" } satisfies ReadyMessage));

        channel.setState("open");
        events.onopen?.();

        for (const buffered of bufferedMessages) {
          if (shouldIgnorePostHelloPlaintext(buffered)) continue;
          transport.onmessage?.(buffered);
        }

        resolve(channel);
      } catch (error) {
        reject(error);
      }
    };

    transport.onerror = (error) => {
      reject(error);
    };

    transport.onclose = (code, reason) => {
      reject(new Error(`Connection closed during handshake: ${code} ${reason}`));
    };
  });
}

/**
 * Encrypted channel that wraps a transport with E2EE.
 */
export class EncryptedChannel {
  private transport: Transport;
  private sharedKey: SharedKey;
  private state: ChannelState = "handshaking";
  private events: EncryptedChannelEvents;
  private options: EncryptedChannelOptions;
  private pendingSends: Array<string | ArrayBuffer> = [];
  private onOpenCallbacks: Array<() => void> = [];
  private onCloseCallbacks: Array<() => void> = [];

  constructor(
    transport: Transport,
    sharedKey: SharedKey,
    events: EncryptedChannelEvents = {},
    options: EncryptedChannelOptions = {}
  ) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;
    this.options = options;

    transport.onmessage = (data) => this.handleMessage(data);
    transport.onclose = (code, reason) => {
      this.state = "closed";
      this.events.onclose?.(code, reason);
      for (const cb of this.onCloseCallbacks) cb();
    };
    transport.onerror = (error) => {
      this.events.onerror?.(error);
    };
  }

  setState(state: ChannelState): void {
    this.state = state;
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const msg = JSON.parse(text) as Partial<ReadyMessage>;
        if (msg.type === "ready") {
          this.state = "open";
          this.events.onopen?.();
          for (const cb of this.onOpenCallbacks) cb();
          await this.flushPendingSends();
        }
      } catch {
        // ignore non-ready handshake traffic
      }
      return;
    }

    if (this.state !== "open") return;

    try {
      const ciphertext = await (async () => {
        // Handle (or ignore) any stray plaintext handshake traffic.
        try {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data);
          if (text.trim().startsWith("{")) {
            const parsed = JSON.parse(text) as Partial<HelloMessage | ReadyMessage>;

            if (parsed.type === "hello" && typeof parsed.key === "string") {
              if (this.options.daemonKeyPair) {
                try {
                  const clientPublicKey = importPublicKey(parsed.key);
                  const nextSharedKey = deriveSharedKey(
                    this.options.daemonKeyPair.secretKey,
                    clientPublicKey
                  );

                  // If it's the same client key (handshake retry), re-send
                  // "ready" but do not re-key. Re-keying here would desync
                  // the channel and cause decrypt failures.
                  if (keysEqual(nextSharedKey, this.sharedKey)) {
                    this.transport.send(
                      JSON.stringify({ type: "ready" } satisfies ReadyMessage)
                    );
                    return null;
                  }

                  // Different key implies a new client connection (common with relays
                  // where the daemon's socket stays open while the client reconnects).
                  // Re-key and re-send "ready". Drop any queued sends to avoid leaking
                  // messages between logical client sessions.
                  this.state = "handshaking";
                  this.sharedKey = nextSharedKey;
                  this.pendingSends = [];
                  this.transport.send(
                    JSON.stringify({ type: "ready" } satisfies ReadyMessage)
                  );
                  this.state = "open";
                  await this.flushPendingSends();
                  return null;
                } catch (error) {
                  throw error;
                }
              }
              return null;
            }

            if (parsed.type === "ready") {
              return null;
            }

            // Any other JSON-looking payload is plaintext app traffic, which
            // means the peer is not encrypting (or we are out of sync).
            throw new Error("Received plaintext frame on encrypted channel");
          }
        } catch (error) {
          // If we detected plaintext protocol mismatch, fail hard.
          if (error instanceof Error && error.message.includes("plaintext frame")) {
            throw error;
          }
          // Otherwise ignore JSON parse/TextDecoder failures and fall back to
          // decoding ciphertext below.
        }

        if (typeof data === "string") {
          return base64ToArrayBuffer(data);
        }

        // Some WebSocket implementations deliver text frames as ArrayBuffer.
        // Our protocol always transmits ciphertext as base64 text.
        try {
          const decoded = new TextDecoder().decode(data);
          return base64ToArrayBuffer(decoded);
        } catch {
          return data;
        }
      })();

      if (ciphertext) {
        const plaintext = await decrypt(this.sharedKey, ciphertext);
        this.events.onmessage?.(plaintext);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Treat decryption/protocol errors as fatal so the peer can reconnect and
      // re-handshake. Emitting an error event here can cause higher-level code
      // to tear down the session without triggering a clean reconnect.
      try {
        this.transport.close(1011, err.message);
      } catch {
        // ignore
      }
    }
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(data);
      return;
    }

    if (this.state !== "open") {
      throw new Error("Channel not open");
    }

    const ciphertext = await encrypt(this.sharedKey, data);
    // Send as base64 for WebSocket text compatibility
    this.transport.send(arrayBufferToBase64(ciphertext));
  }

  private async flushPendingSends(): Promise<void> {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      await this.send(item);
    }
  }

  close(code = 1000, reason = "Normal closure"): void {
    this.state = "closed";
    this.transport.close(code, reason);
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  onTransitionToOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }
}

function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
