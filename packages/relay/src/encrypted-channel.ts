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

interface HelloMessage {
  type: "hello";
  key: string;
}

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
  const keyPair = await generateKeyPair();
  const daemonPublicKey = await importPublicKey(daemonPublicKeyB64);
  const sharedKey = await deriveSharedKey(keyPair.privateKey, daemonPublicKey);

  const channel = new EncryptedChannel(transport, sharedKey, events);

  // Send hello with our public key
  const ourPublicKeyB64 = await exportPublicKey(keyPair.publicKey);
  const hello: HelloMessage = { type: "hello", key: ourPublicKeyB64 };
  transport.send(JSON.stringify(hello));

  channel.setState("open");
  events.onopen?.();

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
  daemonKeyPair: CryptoKeyPair,
  events: EncryptedChannelEvents = {}
): Promise<EncryptedChannel> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Handshake timeout"));
    }, 10000);

    transport.onmessage = async (data) => {
      try {
        if (typeof data !== "string") {
          throw new Error("Expected string hello message");
        }

        const msg = JSON.parse(data) as HelloMessage;
        if (msg.type !== "hello" || !msg.key) {
          throw new Error("Invalid hello message");
        }

        clearTimeout(timeout);

        const clientPublicKey = await importPublicKey(msg.key);
        const sharedKey = await deriveSharedKey(
          daemonKeyPair.privateKey,
          clientPublicKey
        );

        const channel = new EncryptedChannel(transport, sharedKey, events);
        channel.setState("open");
        events.onopen?.();

        resolve(channel);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    };

    transport.onerror = (error) => {
      clearTimeout(timeout);
      reject(error);
    };

    transport.onclose = (code, reason) => {
      clearTimeout(timeout);
      reject(new Error(`Connection closed during handshake: ${code} ${reason}`));
    };
  });
}

/**
 * Encrypted channel that wraps a transport with E2EE.
 */
export class EncryptedChannel {
  private transport: Transport;
  private sharedKey: CryptoKey;
  private state: ChannelState = "handshaking";
  private events: EncryptedChannelEvents;

  constructor(
    transport: Transport,
    sharedKey: CryptoKey,
    events: EncryptedChannelEvents = {}
  ) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;

    transport.onmessage = (data) => this.handleMessage(data);
    transport.onclose = (code, reason) => {
      this.state = "closed";
      this.events.onclose?.(code, reason);
    };
    transport.onerror = (error) => {
      this.events.onerror?.(error);
    };
  }

  setState(state: ChannelState): void {
    this.state = state;
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (this.state !== "open") return;

    try {
      const ciphertext =
        typeof data === "string" ? base64ToArrayBuffer(data) : data;
      const plaintext = await decrypt(this.sharedKey, ciphertext);
      this.events.onmessage?.(plaintext);
    } catch (error) {
      this.events.onerror?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state !== "open") {
      throw new Error("Channel not open");
    }

    const ciphertext = await encrypt(this.sharedKey, data);
    // Send as base64 for WebSocket text compatibility
    this.transport.send(arrayBufferToBase64(ciphertext));
  }

  close(code = 1000, reason = "Normal closure"): void {
    this.state = "closed";
    this.transport.close(code, reason);
  }

  isOpen(): boolean {
    return this.state === "open";
  }
}
