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
  send(data: string | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onmessage: ((message: TransportMessage) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface TransportMessage {
  data: string | ArrayBuffer;
  isBinary: boolean;
}

export interface EncryptedChannelEvents {
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (error: Error) => void;
}

type ChannelState = "connecting" | "handshaking" | "open" | "closed";

interface EncryptedChannelOptions {
  /**
   * If set, the channel can validate repeated plaintext `{type:"e2ee_hello"}`
   * messages even after it is open.
   *
   * This is useful for robustness when the client retries the handshake
   * (e.g., it didn't observe the daemon's `{type:"e2ee_ready"}` yet). In that case,
   * the daemon should re-send `{type:"e2ee_ready"}` without changing keys.
   */
  daemonKeyPair?: KeyPair;
  binaryCiphertext?: boolean;
}

interface E2EEHelloMessage {
  type: "e2ee_hello";
  key: string;
  capabilities?: E2EECapabilities;
}

interface E2EEReadyMessage {
  type: "e2ee_ready";
  capabilities?: E2EECapabilities;
}

interface E2EECapabilities {
  binaryCiphertext?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isE2EECapabilities(value: unknown): value is E2EECapabilities {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.binaryCiphertext === undefined || typeof value.binaryCiphertext === "boolean"))
  );
}

function isE2EEHelloMessage(value: unknown): value is E2EEHelloMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0 &&
    isE2EECapabilities(value.capabilities)
  );
}

function isE2EEReadyMessage(value: unknown): value is E2EEReadyMessage {
  return isRecord(value) && value.type === "e2ee_ready" && isE2EECapabilities(value.capabilities);
}

function supportsBinaryCiphertext(message: E2EEHelloMessage | E2EEReadyMessage): boolean {
  return message.capabilities?.binaryCiphertext === true;
}

function buildInvalidHelloError(rawText: string, parsed?: unknown): Error {
  const parsedRecord = isRecord(parsed) ? parsed : null;
  const rawType = parsedRecord?.type;
  function describeType(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    return typeof value;
  }
  const receivedType = describeType(rawType);
  const hasKey = typeof parsedRecord?.key === "string" && parsedRecord.key.trim().length > 0;
  const compact = rawText.replace(/\s+/g, " ").trim();
  const preview = compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  return new Error(
    `Invalid hello message (receivedType=${receivedType}, hasKey=${hasKey}, preview=${JSON.stringify(preview)})`,
  );
}

const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;
const REHANDSHAKE_KEY_MISMATCH_CLOSE_CODE = 1008;
const REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON = "E2EE re-handshake key mismatch";

interface TimeoutWithUnref {
  unref(): void;
}

function hasUnref(timeout: unknown): timeout is TimeoutWithUnref {
  return (
    typeof timeout === "object" &&
    timeout !== null &&
    "unref" in timeout &&
    typeof (timeout as Record<string, unknown>).unref === "function"
  );
}

/**
 * Creates an encrypted channel as the initiator (client).
 *
 * The client:
 * 1. Receives daemon's public key via QR code
 * 2. Generates own keypair
 * 3. Sends e2ee_hello with own public key
 * 4. Derives shared key and starts encrypted communication
 */
export async function createClientChannel(
  transport: Transport,
  daemonPublicKeyB64: string,
  events: EncryptedChannelEvents = {},
): Promise<EncryptedChannel> {
  const keyPair = generateKeyPair();
  const daemonPublicKey = importPublicKey(daemonPublicKeyB64);
  const sharedKey = deriveSharedKey(keyPair.secretKey, daemonPublicKey);

  const channel = new EncryptedChannel(transport, sharedKey, events);

  // Send e2ee_hello with our public key
  const ourPublicKeyB64 = exportPublicKey(keyPair.publicKey);
  const hello: E2EEHelloMessage = {
    type: "e2ee_hello",
    key: ourPublicKeyB64,
    capabilities: { binaryCiphertext: true },
  };
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
  if (hasUnref(retry)) {
    retry.unref();
  }

  return channel;
}

/**
 * Creates an encrypted channel as the responder (daemon).
 *
 * The daemon:
 * 1. Has pre-generated keypair (public key was in QR)
 * 2. Waits for client's e2ee_hello with their public key
 * 3. Derives shared key and starts encrypted communication
 */
export async function createDaemonChannel(
  transport: Transport,
  daemonKeyPair: KeyPair,
  events: EncryptedChannelEvents = {},
): Promise<EncryptedChannel> {
  return new Promise((resolve, reject) => {
    const bufferedMessages: TransportMessage[] = [];
    const shouldIgnorePostHelloPlaintext = (message: TransportMessage): boolean => {
      try {
        if (message.isBinary) return false;
        const text = decodeTransportText(message.data);
        const parsed: unknown = JSON.parse(text);
        return isE2EEHelloMessage(parsed) || isE2EEReadyMessage(parsed);
      } catch {
        return false;
      }
    };

    const handleHello = async (message: TransportMessage): Promise<void> => {
      try {
        if (message.isBinary) {
          throw buildInvalidHelloError("<binary frame>");
        }
        const helloText = decodeTransportText(message.data);

        let parsed: unknown;
        try {
          parsed = JSON.parse(helloText);
        } catch {
          throw buildInvalidHelloError(helloText);
        }

        if (!isE2EEHelloMessage(parsed)) {
          throw buildInvalidHelloError(helloText, parsed);
        }

        const msg = parsed;

        // Buffer any subsequent messages that arrive while we're doing async
        // WebCrypto work to derive the shared key. Without this, it's possible
        // for the next message (already encrypted) to be misinterpreted as a
        // second hello, causing the handshake to fail.
        const bufferNext = (next: TransportMessage): void => {
          bufferedMessages.push(next);
        };
        Object.assign(transport, { onmessage: bufferNext });

        const clientPublicKey = importPublicKey(msg.key);
        const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPublicKey);

        const binaryCiphertext = supportsBinaryCiphertext(msg);
        await transport.send(
          JSON.stringify({
            type: "e2ee_ready",
            ...(binaryCiphertext
              ? { capabilities: { binaryCiphertext: true } satisfies E2EECapabilities }
              : {}),
          } satisfies E2EEReadyMessage),
        );

        const channel = new EncryptedChannel(transport, sharedKey, events, {
          daemonKeyPair,
          binaryCiphertext,
        });
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

    Object.assign(transport, {
      onmessage: handleHello,
      onerror: (error: Error) => {
        reject(error);
      },
      onclose: (code: number, reason: string) => {
        reject(new Error(`Connection closed during handshake: ${code} ${reason}`));
      },
    });
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
    options: EncryptedChannelOptions = {},
  ) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;
    this.options = options;

    Object.assign(transport, {
      onmessage: (message: TransportMessage) => this.handleMessage(message),
      onclose: (code: number, reason: string) => {
        this.state = "closed";
        this.events.onclose?.(code, reason);
        for (const cb of this.onCloseCallbacks) cb();
      },
      onerror: (error: Error) => {
        this.events.onerror?.(error);
      },
    });
  }

  setState(state: ChannelState): void {
    this.state = state;
  }

  private async handleMessage(message: TransportMessage): Promise<void> {
    if (this.state === "handshaking") {
      try {
        if (message.isBinary) return;
        const text = decodeTransportText(message.data);
        const parsed: unknown = JSON.parse(text);
        if (isE2EEReadyMessage(parsed)) {
          this.options.binaryCiphertext = supportsBinaryCiphertext(parsed);
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
          if (message.isBinary) throw new Error("not plaintext handshake traffic");
          const text = decodeTransportText(message.data);
          if (text.trim().startsWith("{")) {
            const parsed: unknown = JSON.parse(text);

            if (isE2EEHelloMessage(parsed)) {
              if (this.options.daemonKeyPair) {
                await this.handleDaemonRehello(parsed);
              }
              return null;
            }

            if (isE2EEReadyMessage(parsed)) {
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

        if (this.options.binaryCiphertext) {
          return message.isBinary
            ? { data: requireArrayBuffer(message.data), isBinary: true as const }
            : {
                data: base64ToArrayBuffer(decodeTransportText(message.data)),
                isBinary: false as const,
              };
        }

        // COMPAT(binaryCiphertext): added in v0.2.3, remove legacy base64-only
        // receive mode after 2027-01-27.
        if (!message.isBinary) {
          return { data: base64ToArrayBuffer(decodeTransportText(message.data)), isBinary: null };
        }

        // Older transport adapters could lose the opcode. Retain the former
        // base64-first behavior only in the legacy path.
        try {
          return { data: base64ToArrayBuffer(decodeTransportText(message.data)), isBinary: null };
        } catch {
          return { data: requireArrayBuffer(message.data), isBinary: null };
        }
      })();

      if (ciphertext) {
        const plaintextBytes = decrypt(this.sharedKey, ciphertext.data);
        const plaintext = decodePlaintext(plaintextBytes, ciphertext.isBinary);
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

    const ciphertext = encrypt(this.sharedKey, data);
    if (this.options.binaryCiphertext && data instanceof ArrayBuffer) {
      await this.transport.send(ciphertext);
      return;
    }
    // COMPAT(binaryCiphertext): added in v0.2.3, remove base64 binary sends
    // after 2027-01-27 once the supported peer floor includes negotiation.
    await this.transport.send(arrayBufferToBase64(ciphertext));
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    const encryptedBytes = utf8ByteLength(data) + 40;
    if (this.options.binaryCiphertext && data instanceof ArrayBuffer) {
      return encryptedBytes;
    }
    return 4 * Math.ceil(encryptedBytes / 3);
  }

  private async flushPendingSends(): Promise<void> {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      await this.send(item);
    }
  }

  private async handleDaemonRehello(message: E2EEHelloMessage): Promise<void> {
    if (!this.options.daemonKeyPair) return;
    const clientPublicKey = importPublicKey(message.key);
    const nextSharedKey = deriveSharedKey(this.options.daemonKeyPair.secretKey, clientPublicKey);

    // If it's the same client key (handshake retry), re-send
    // "ready" but do not re-key. Re-keying here would desync
    // the channel and cause decrypt failures.
    if (keysEqual(nextSharedKey, this.sharedKey)) {
      await this.transport.send(
        JSON.stringify({
          type: "e2ee_ready",
          ...(this.options.binaryCiphertext
            ? { capabilities: { binaryCiphertext: true } satisfies E2EECapabilities }
            : {}),
        } satisfies E2EEReadyMessage),
      );
      return;
    }

    // A different key on an already-open encrypted channel is not an
    // authenticated reconnect. Close and require a fresh transport instead of
    // allowing the relay to switch this channel to an attacker-chosen key.
    this.state = "closed";
    this.transport.close(
      REHANDSHAKE_KEY_MISMATCH_CLOSE_CODE,
      REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON,
    );
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

function decodeTransportText(data: string | ArrayBuffer): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function requireArrayBuffer(data: string | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  throw new Error("Binary WebSocket frame did not contain bytes");
}

function decodeLegacyPlaintext(data: ArrayBuffer): string | ArrayBuffer {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return data;
  }
}

function decodePlaintext(data: ArrayBuffer, isBinary: boolean | null): string | ArrayBuffer {
  if (isBinary === true) return data;
  if (isBinary === false) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  return decodeLegacyPlaintext(data);
}

function utf8ByteLength(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}
