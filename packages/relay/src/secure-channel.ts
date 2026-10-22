/// <reference lib="dom" />
/**
 * Endpoint security for relay-carried daemon sessions.
 *
 * This is the one entrypoint both endpoints use to secure a transport. It owns
 * the handshake, record protection, counters, retries, termination, and the
 * negotiated security mode. Relay adapters own routing and physical I/O;
 * daemon admission owns credentials and authorization.
 *
 * Two modes exist during migration:
 *
 * - "protected": conforming Noise_NK_25519_ChaChaPoly_SHA256 bound to the
 *   daemon's static key, with authenticated record framing. Handshake
 *   messages travel byte-exact (base64) inside the existing `e2ee_hello` /
 *   `e2ee_ready` JSON envelopes under `protected`.
 * - "legacy": the pre-existing ephemeral-static box construction in
 *   `encrypted-channel.ts`. It has no replay protection. Chosen only when the
 *   peer omits `protected` (an older peer) and policy allows it.
 *
 * A present but invalid `protected` field never falls back to legacy.
 *
 * See docs/relay-endpoint-security.md for the byte-level mapping.
 */

import {
  EncryptedChannel,
  base64EncryptedWireByteLength,
  maxBase64EncryptedPlaintextByteLength,
  type EncryptedChannelEvents,
  type Transport,
  type TransportMessage,
} from "./encrypted-channel.js";
import {
  deriveSharedKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  type KeyPair,
} from "./crypto.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";
import {
  createNoiseInitiator,
  createNoiseResponder,
  NoiseProtocolError,
  type CipherState,
  type NoiseHandshake,
} from "./noise/index.js";
import {
  decodeProtectedRecord,
  encodeProtectedRecord,
  protectedRecordByteLength,
} from "./protected-records.js";

export type SecurityMode = "legacy" | "protected";

export type SecureChannelEvents = EncryptedChannelEvents;

export interface SecureChannel {
  send(data: string | ArrayBuffer): Promise<void>;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
  securityMode(): SecurityMode;
  /** Bytes the transport will carry for `data`, including protection overhead. */
  outboundWireByteLength(data: string | ArrayBuffer): number;
  onTransitionToOpen(cb: () => void): void;
  onClose(cb: () => void): void;
}

export interface ClientSecureChannelOptions {
  daemonPublicKeyB64: string;
  /** Lowest mode this client accepts. "protected" refuses a daemon that only offers legacy. */
  minimumMode?: SecurityMode;
  events?: SecureChannelEvents;
}

export interface DaemonSecureChannelOptions {
  daemonKeyPair: KeyPair;
  /**
   * Lowest mode this daemon admits. "protected" refuses a client that only
   * offers legacy. A function is evaluated when the hello arrives so a policy
   * change applies to every admission from that moment on.
   */
  minimumMode?: SecurityMode | (() => SecurityMode);
  events?: SecureChannelEvents;
}

/** Thrown by {@link openDaemonSecureChannel} when the handshake is refused; carries the close to send. */
export class SecureChannelRejectedError extends Error {
  constructor(
    message: string,
    readonly closeCode: number,
    readonly closeReason: string,
  ) {
    super(message);
    this.name = "SecureChannelRejectedError";
  }
}

export const PROTECTED_MODE_REQUIRED_CLOSE_CODE = 1008;
export const PROTECTED_MODE_REQUIRED_CLOSE_REASON = "protected endpoint security required";
/** Client-side close when a protected handshake fails. Browser-safe (4000-4999). */
export const PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE = 4002;
/**
 * Client-side close when an inbound record fails authentication or framing.
 * Browser WebSocket.close accepts only 1000 or 3000-4999, so a client must
 * never try to send a 1011.
 */
export const PROTECTED_RECORD_FAILED_CLOSE_CODE = 4003;
/** Daemon-side close for the same failures; the daemon runs on Node's ws. */
const DAEMON_RECORD_FAILURE_CLOSE_CODE = 1011;
const REHANDSHAKE_REJECTION_CODE = 1008;
const REHANDSHAKE_MISMATCH_CLOSE_REASON = "E2EE re-handshake transcript mismatch";

const NOISE_PROLOGUE = new TextEncoder().encode("paseo-relay-e2ee/1");
const PROTECTED_ENVELOPE_VERSION = 1;
const PARAMS_VERSION = 0x01;
const PARAM_FLAG_BINARY_CIPHERTEXT = 0x01;
const PARAM_FLAGS_KNOWN = PARAM_FLAG_BINARY_CIPHERTEXT;
const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;

interface ProtectedEnvelope {
  v: number;
  message: string;
}

interface HelloEnvelope {
  type: "e2ee_hello";
  key: string;
  capabilities?: { binaryCiphertext?: boolean };
  protected?: ProtectedEnvelope;
}

interface ReadyEnvelope {
  type: "e2ee_ready";
  capabilities?: { binaryCiphertext?: boolean };
  protected?: ProtectedEnvelope;
}

interface NegotiatedParams {
  binaryCiphertext: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Secures a transport as the initiator. Resolves once the hello has been sent;
 * `events.onopen` fires when the channel is usable. Sends queued before open
 * are flushed in order after the handshake, capped at {@link MAX_PENDING_SENDS}.
 */
export async function openClientSecureChannel(
  transport: Transport,
  options: ClientSecureChannelOptions,
): Promise<SecureChannel> {
  const events = options.events ?? {};
  const minimumMode = options.minimumMode ?? "legacy";
  const daemonPublicKey = importPublicKey(options.daemonPublicKeyB64);

  // Separate ephemeral keys per protocol: the legacy box key is routing and
  // compatibility input only; the Noise ephemeral lives inside the handshake.
  const legacyKeyPair = generateKeyPair();
  const legacySharedKey = deriveSharedKey(legacyKeyPair.secretKey, daemonPublicKey);
  const noise = createNoiseInitiator({ remoteStatic: daemonPublicKey, prologue: NOISE_PROLOGUE });
  const offered: NegotiatedParams = { binaryCiphertext: true };
  const msg1 = noise.writeMessage(encodeParams(offered));
  const hello: HelloEnvelope = {
    type: "e2ee_hello",
    key: exportPublicKey(legacyKeyPair.publicKey),
    capabilities: { binaryCiphertext: true },
    protected: { v: PROTECTED_ENVELOPE_VERSION, message: arrayBufferToBase64(toArrayBuffer(msg1)) },
  };
  const helloText = JSON.stringify(hello);

  const channel = new ClientSecureChannel(transport, events, {
    minimumMode,
    noise,
    offered,
    legacySharedKey,
  });

  let retry: ReturnType<typeof setInterval> | null = null;
  const emitSendError = (error: unknown) => {
    events.onerror?.(error instanceof Error ? error : new Error(String(error)));
  };
  const sendHello = () => {
    try {
      const result = transport.send(helloText);
      if (result) void result.catch(emitSendError);
    } catch (error) {
      // Daemon restarts move the socket through CLOSING/CLOSED; report, never throw from timers.
      emitSendError(error);
    }
  };
  const clearRetry = () => {
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
  };
  channel.onTransitionToOpen(clearRetry);
  channel.onClose(clearRetry);

  sendHello();
  retry = setInterval(() => {
    if (channel.isOpen()) {
      clearRetry();
      return;
    }
    sendHello();
  }, HANDSHAKE_RETRY_MS);
  unref(retry);

  return channel;
}

interface ClientHandshakeState {
  minimumMode: SecurityMode;
  noise: NoiseHandshake;
  offered: NegotiatedParams;
  legacySharedKey: Uint8Array;
}

/**
 * Client channel: waits for the daemon's ready, selects the mode, then
 * delegates records to the mode's implementation.
 */
class ClientSecureChannel implements SecureChannel {
  private state: "handshaking" | "open" | "closed" = "handshaking";
  private closeNotified = false;
  private inner: InnerChannel | null = null;
  private pendingSends: Array<string | ArrayBuffer> = [];
  private readonly onOpenCallbacks: Array<() => void> = [];
  private readonly onCloseCallbacks: Array<() => void> = [];
  private handshake: ClientHandshakeState | null;

  constructor(
    private readonly transport: Transport,
    private readonly events: SecureChannelEvents,
    handshake: ClientHandshakeState,
  ) {
    this.handshake = handshake;
    Object.assign(transport, {
      onmessage: (message: TransportMessage) => this.handleHandshakeMessage(message),
      onclose: (code: number, reason: string) => this.handleTransportClose(code, reason),
      onerror: (error: Error) => this.events.onerror?.(error),
    });
  }

  private handleHandshakeMessage(message: TransportMessage): void {
    if (this.state !== "handshaking" || !this.handshake) return;
    let parsed: unknown;
    try {
      if (message.isBinary) return;
      parsed = JSON.parse(decodeTransportText(message.data));
    } catch {
      return; // not handshake traffic; ignore while handshaking
    }
    if (!isRecord(parsed) || parsed.type !== "e2ee_ready") return;

    try {
      // A ready the daemon recognizably sent but that fails validation is a
      // broken or tampered handshake, never unrelated traffic to wait past.
      if (!isReadyEnvelope(parsed)) throw new NoiseProtocolError("malformed ready envelope");
      const ready: ReadyEnvelope = parsed;
      if (ready.protected !== undefined) {
        this.openProtected(ready.protected);
      } else {
        this.openLegacy(ready);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.events.onerror?.(err);
      this.fail(PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, err.message);
    }
  }

  private openProtected(envelope: ProtectedEnvelope): void {
    const handshake = this.handshake!;
    if (envelope.v !== PROTECTED_ENVELOPE_VERSION) {
      throw new NoiseProtocolError("unsupported protected envelope version");
    }
    const msg2 = new Uint8Array(base64ToArrayBuffer(envelope.message));
    const selected = decodeParams(handshake.noise.readMessage(msg2));
    if (selected.binaryCiphertext && !handshake.offered.binaryCiphertext) {
      throw new NoiseProtocolError("daemon selected an unoffered parameter");
    }
    const keys = handshake.noise.split();
    this.becomeOpen(
      new ProtectedChannel(this.transport, this.events, keys.send, keys.receive, selected, {
        retry: null,
        failureCloseCode: PROTECTED_RECORD_FAILED_CLOSE_CODE,
      }),
    );
  }

  private openLegacy(ready: ReadyEnvelope): void {
    const handshake = this.handshake!;
    if (handshake.minimumMode === "protected") {
      throw new Error("daemon offered only legacy endpoint security");
    }
    const legacy = new EncryptedChannel(this.transport, handshake.legacySharedKey, this.events, {
      binaryCiphertext: ready.capabilities?.binaryCiphertext === true,
    });
    legacy.setState("open");
    this.becomeOpen(new LegacyInner(legacy));
  }

  private becomeOpen(inner: InnerChannel): void {
    this.handshake = null;
    this.inner = inner;
    this.state = "open";
    // The mode implementation now owns the transport callbacks; mirror its close.
    inner.onClose(() => this.notifyClosed());
    this.events.onopen?.();
    for (const cb of this.onOpenCallbacks) cb();
    const pending = this.pendingSends;
    this.pendingSends = [];
    void (async () => {
      try {
        for (const item of pending) await inner.send(item);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.events.onerror?.(err);
        this.fail(PROTECTED_RECORD_FAILED_CLOSE_CODE, err.message);
      }
    })();
  }

  /** Transport closed while this wrapper still owned its callbacks (handshaking). */
  private handleTransportClose(code: number, reason: string): void {
    this.events.onclose?.(code, reason);
    this.notifyClosed();
  }

  private notifyClosed(): void {
    this.state = "closed";
    this.handshake = null;
    if (this.closeNotified) return;
    this.closeNotified = true;
    for (const cb of this.onCloseCallbacks) cb();
  }

  private fail(code: number, reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.handshake = null;
    try {
      this.transport.close(code, reason);
    } catch {
      // ignore
    }
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) this.pendingSends.shift();
      this.pendingSends.push(data);
      return;
    }
    if (this.state !== "open" || !this.inner) throw new Error("Channel not open");
    await this.inner.send(data);
  }

  close(code = 1000, reason = "Normal closure"): void {
    if (this.inner) {
      this.inner.close(code, reason);
    } else {
      this.transport.close(code, reason);
    }
    this.state = "closed";
    this.handshake = null;
  }

  isOpen(): boolean {
    return this.state === "open" && this.inner?.isOpen() === true;
  }

  securityMode(): SecurityMode {
    if (!this.inner) throw new Error("security mode is unknown until the channel opens");
    return this.inner.mode;
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    if (this.inner) return this.inner.outboundWireByteLength(data);
    // Mode unknown while handshaking: report the larger of the two so callers stay within limits.
    const plaintextBytes = typeof data === "string" ? utf8ByteLength(data) : data.byteLength;
    return Math.max(
      base64EncryptedWireByteLength(plaintextBytes),
      4 * Math.ceil(protectedRecordByteLength(plaintextBytes) / 3),
    );
  }

  onTransitionToOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

/**
 * Secures a transport as the responder. Resolves once the peer's hello has
 * been accepted and the ready sent. Rejects with
 * {@link SecureChannelRejectedError} when policy refuses the peer, and with a
 * plain error for malformed or failed handshakes; the caller closes the socket.
 */
export async function openDaemonSecureChannel(
  transport: Transport,
  options: DaemonSecureChannelOptions,
): Promise<SecureChannel> {
  const events = options.events ?? {};
  const minimumMode = (): SecurityMode =>
    typeof options.minimumMode === "function"
      ? options.minimumMode()
      : (options.minimumMode ?? "legacy");
  return new Promise((resolve, reject) => {
    const buffered: TransportMessage[] = [];

    const handleHello = async (message: TransportMessage): Promise<void> => {
      try {
        if (message.isBinary) throw new Error("Invalid hello message (binary frame)");
        const helloText = decodeTransportText(message.data);
        let parsed: unknown;
        try {
          parsed = JSON.parse(helloText);
        } catch {
          throw new Error(`Invalid hello message: ${preview(helloText)}`);
        }
        if (!isHelloEnvelope(parsed))
          throw new Error(`Invalid hello message: ${preview(helloText)}`);

        // Buffer traffic that arrives while the ready is in flight so an early
        // record is not mistaken for a second hello.
        Object.assign(transport, { onmessage: (next: TransportMessage) => buffered.push(next) });

        const channel =
          parsed.protected !== undefined
            ? await acceptProtectedHello(
                transport,
                events,
                options.daemonKeyPair,
                parsed,
                helloText,
              )
            : await acceptLegacyHello(
                transport,
                events,
                options.daemonKeyPair,
                parsed,
                minimumMode(),
              );

        events.onopen?.();
        // The channel now owns the transport: buffered records are decoded and a
        // buffered hello retry gets the same exact-transcript answer as a live one.
        for (const next of buffered) transport.onmessage?.(next);
        resolve(channel);
      } catch (error) {
        reject(error);
      }
    };

    Object.assign(transport, {
      onmessage: handleHello,
      onerror: (error: Error) => reject(error),
      onclose: (code: number, reason: string) =>
        reject(new Error(`Connection closed during handshake: ${code} ${reason}`)),
    });
  });
}

async function acceptProtectedHello(
  transport: Transport,
  events: SecureChannelEvents,
  daemonKeyPair: KeyPair,
  hello: HelloEnvelope,
  helloText: string,
): Promise<SecureChannel> {
  const envelope = hello.protected!;
  if (envelope.v !== PROTECTED_ENVELOPE_VERSION) {
    throw new NoiseProtocolError("unsupported protected envelope version");
  }
  const noise = createNoiseResponder({ localStatic: daemonKeyPair, prologue: NOISE_PROLOGUE });
  const msg1 = new Uint8Array(base64ToArrayBuffer(envelope.message));
  const offered = decodeParams(noise.readMessage(msg1));
  const selected: NegotiatedParams = { binaryCiphertext: offered.binaryCiphertext };
  const msg2 = noise.writeMessage(encodeParams(selected));
  const ready: ReadyEnvelope = {
    type: "e2ee_ready",
    protected: { v: PROTECTED_ENVELOPE_VERSION, message: arrayBufferToBase64(toArrayBuffer(msg2)) },
  };
  const readyText = JSON.stringify(ready);
  await transport.send(readyText);
  const keys = noise.split();
  return new ProtectedChannel(transport, events, keys.send, keys.receive, selected, {
    retry: { helloText, readyText },
    failureCloseCode: DAEMON_RECORD_FAILURE_CLOSE_CODE,
  });
}

async function acceptLegacyHello(
  transport: Transport,
  events: SecureChannelEvents,
  daemonKeyPair: KeyPair,
  hello: HelloEnvelope,
  minimumMode: SecurityMode,
): Promise<SecureChannel> {
  if (minimumMode === "protected") {
    throw new SecureChannelRejectedError(
      "client offered only legacy endpoint security",
      PROTECTED_MODE_REQUIRED_CLOSE_CODE,
      PROTECTED_MODE_REQUIRED_CLOSE_REASON,
    );
  }
  const clientPublicKey = importPublicKey(hello.key);
  const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPublicKey);
  const binaryCiphertext = hello.capabilities?.binaryCiphertext === true;
  await transport.send(
    JSON.stringify({
      type: "e2ee_ready",
      ...(binaryCiphertext ? { capabilities: { binaryCiphertext: true } } : {}),
    } satisfies ReadyEnvelope),
  );
  const legacy = new EncryptedChannel(transport, sharedKey, events, {
    daemonKeyPair,
    binaryCiphertext,
  });
  legacy.setState("open");
  return new LegacyInner(legacy);
}

// ---------------------------------------------------------------------------
// Mode implementations
// ---------------------------------------------------------------------------

interface InnerChannel extends SecureChannel {
  readonly mode: SecurityMode;
}

class LegacyInner implements InnerChannel {
  readonly mode = "legacy" as const;
  constructor(readonly legacy: EncryptedChannel) {}
  send(data: string | ArrayBuffer): Promise<void> {
    return this.legacy.send(data);
  }
  close(code?: number, reason?: string): void {
    this.legacy.close(code, reason);
  }
  isOpen(): boolean {
    return this.legacy.isOpen();
  }
  securityMode(): SecurityMode {
    return this.mode;
  }
  outboundWireByteLength(data: string | ArrayBuffer): number {
    return this.legacy.outboundWireByteLength(data);
  }
  onTransitionToOpen(cb: () => void): void {
    this.legacy.onTransitionToOpen(cb);
  }
  onClose(cb: () => void): void {
    this.legacy.onClose(cb);
  }
}

interface DaemonRetryTranscript {
  helloText: string;
  readyText: string;
}

/**
 * Protected records over an open transport. Every inbound record is
 * authenticated and framing-checked before delivery; any failure closes the
 * channel and clears the keys.
 */
class ProtectedChannel implements InnerChannel {
  readonly mode = "protected" as const;
  private state: "open" | "closed" = "open";
  private readonly onCloseCallbacks: Array<() => void> = [];

  constructor(
    private readonly transport: Transport,
    private readonly events: SecureChannelEvents,
    private readonly sender: CipherState,
    private readonly receiver: CipherState,
    private readonly params: NegotiatedParams,
    private readonly role: {
      /** Daemon side only: exact transcript used to answer identical retries. */
      retry: DaemonRetryTranscript | null;
      failureCloseCode: number;
    },
  ) {
    Object.assign(transport, {
      onmessage: (message: TransportMessage) => this.handleMessage(message),
      onclose: (code: number, reason: string) => {
        this.markClosed();
        this.events.onclose?.(code, reason);
      },
      onerror: (error: Error) => this.events.onerror?.(error),
    });
  }

  private async handleMessage(message: TransportMessage): Promise<void> {
    if (this.state !== "open") return;
    try {
      const handshake = !message.isBinary ? parseHandshakeEnvelope(message.data) : null;
      if (handshake) {
        await this.handleHandshakeTraffic(handshake);
        return;
      }
      const record = message.isBinary
        ? new Uint8Array(requireArrayBuffer(message.data))
        : new Uint8Array(base64ToArrayBuffer(decodeTransportText(message.data)));
      const frame = decodeProtectedRecord(record, this.receiver);
      const plaintext =
        frame.kind === "text"
          ? new TextDecoder("utf-8", { fatal: true }).decode(frame.data)
          : toArrayBuffer(frame.data);
      this.events.onmessage?.(plaintext);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.fail(this.role.failureCloseCode, err.message);
    }
  }

  private async handleHandshakeTraffic(
    handshake: { kind: "hello"; text: string } | { kind: "ready" },
  ): Promise<void> {
    if (handshake.kind === "ready") return; // client ignores duplicate ready after open
    if (!this.role.retry) return; // a client never answers hellos
    if (handshake.text === this.role.retry.helloText) {
      await this.transport.send(this.role.retry.readyText);
      return;
    }
    this.fail(REHANDSHAKE_REJECTION_CODE, REHANDSHAKE_MISMATCH_CLOSE_REASON);
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state !== "open") throw new Error("Channel not open");
    const kind = typeof data === "string" ? "text" : "binary";
    const frame = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    let wire: Uint8Array;
    try {
      // Synchronous up to here: the nonce is reserved before any await.
      wire = encodeProtectedRecord(kind, frame, this.sender);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.fail(this.role.failureCloseCode, err.message);
      throw err;
    }
    if (this.params.binaryCiphertext && kind === "binary") {
      await this.transport.send(toArrayBuffer(wire));
      return;
    }
    await this.transport.send(arrayBufferToBase64(toArrayBuffer(wire)));
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    const plaintextBytes = typeof data === "string" ? utf8ByteLength(data) : data.byteLength;
    const wireBytes = protectedRecordByteLength(plaintextBytes);
    if (this.params.binaryCiphertext && typeof data !== "string") return wireBytes;
    return 4 * Math.ceil(wireBytes / 3);
  }

  close(code = 1000, reason = "Normal closure"): void {
    this.markClosed();
    this.transport.close(code, reason);
  }

  private fail(code: number, reason: string): void {
    if (this.state !== "open") return;
    this.markClosed();
    try {
      this.transport.close(code, reason);
    } catch {
      // ignore
    }
  }

  private markClosed(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.sender.clear();
    this.receiver.clear();
    for (const cb of this.onCloseCallbacks) cb();
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  securityMode(): SecurityMode {
    return this.mode;
  }

  onTransitionToOpen(cb: () => void): void {
    cb();
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }
}

/**
 * Largest plaintext that fits in `wireBytes` as a base64 text frame in either
 * mode. Callers size payloads before the mode is known, so take the tighter bound.
 */
export function maxSecuredPlaintextByteLength(wireBytes: number): number {
  const legacy = maxBase64EncryptedPlaintextByteLength(wireBytes);
  const base64Capacity = Math.floor(wireBytes / 4) * 3;
  let protectedBound = base64Capacity;
  while (protectedBound > 0 && protectedRecordByteLength(protectedBound) > base64Capacity) {
    protectedBound = base64Capacity - (protectedRecordByteLength(protectedBound) - protectedBound);
  }
  return Math.max(0, Math.min(legacy, protectedBound));
}

// ---------------------------------------------------------------------------
// Envelope parsing and parameter encoding
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilities(value: unknown): value is { binaryCiphertext?: boolean } {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.binaryCiphertext === undefined || typeof value.binaryCiphertext === "boolean"))
  );
}

function isProtectedEnvelope(value: unknown): value is ProtectedEnvelope {
  return (
    isRecord(value) &&
    typeof value.v === "number" &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isHelloEnvelope(value: unknown): value is HelloEnvelope {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0 &&
    isCapabilities(value.capabilities) &&
    (value.protected === undefined || isProtectedEnvelope(value.protected))
  );
}

function isReadyEnvelope(value: unknown): value is ReadyEnvelope {
  return (
    isRecord(value) &&
    value.type === "e2ee_ready" &&
    isCapabilities(value.capabilities) &&
    (value.protected === undefined || isProtectedEnvelope(value.protected))
  );
}

/** Classifies plaintext handshake traffic seen on an open channel; null for anything else. */
function parseHandshakeEnvelope(
  data: string | ArrayBuffer,
): { kind: "hello"; text: string } | { kind: "ready" } | null {
  let text: string;
  try {
    text = decodeTransportText(data);
  } catch {
    return null;
  }
  if (!text.trim().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Received plaintext frame on encrypted channel");
  }
  if (isRecord(parsed) && parsed.type === "e2ee_hello") return { kind: "hello", text };
  if (isRecord(parsed) && parsed.type === "e2ee_ready") return { kind: "ready" };
  // Any other JSON is plaintext app traffic: the peer is not encrypting.
  throw new Error("Received plaintext frame on encrypted channel");
}

function encodeParams(params: NegotiatedParams): Uint8Array {
  return new Uint8Array([
    PARAMS_VERSION,
    params.binaryCiphertext ? PARAM_FLAG_BINARY_CIPHERTEXT : 0,
  ]);
}

function decodeParams(payload: Uint8Array): NegotiatedParams {
  if (payload.byteLength !== 2) throw new NoiseProtocolError("invalid parameter payload");
  if (payload[0] !== PARAMS_VERSION) throw new NoiseProtocolError("unsupported parameter version");
  if ((payload[1] & ~PARAM_FLAGS_KNOWN) !== 0)
    throw new NoiseProtocolError("reserved parameter flag set");
  return { binaryCiphertext: (payload[1] & PARAM_FLAG_BINARY_CIPHERTEXT) !== 0 };
}

function preview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(compact.length > 160 ? `${compact.slice(0, 157)}...` : compact);
}

function decodeTransportText(data: string | ArrayBuffer): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function requireArrayBuffer(data: string | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  throw new Error("Binary WebSocket frame did not contain bytes");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
