/**
 * Conforming Noise_NK_25519_ChaChaPoly_SHA256 (Noise Protocol Framework rev 34).
 *
 * The pattern is executed token by token from its definition, so the vector
 * tests exercise the same code path as production. Only NK is provided; the
 * daemon's static X25519 key is the responder's `s`, known to the initiator
 * from pairing.
 *
 *   NK:
 *     <- s
 *     ...
 *     -> e, es
 *     <- e, ee
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { CipherState, NoiseProtocolError, NOISE_MAX_MESSAGE_BYTES } from "./cipher-state.js";
import { SymmetricState, concat } from "./symmetric-state.js";

export {
  CipherState,
  NoiseProtocolError,
  NOISE_MAX_MESSAGE_BYTES,
  NOISE_TAG_BYTES,
} from "./cipher-state.js";

export const NOISE_NK_PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
export const DH_BYTES = 32;

export interface NoiseKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface NoiseInitiatorOptions {
  /** Responder's static public key, trusted out of band. */
  remoteStatic: Uint8Array;
  prologue: Uint8Array;
  /** Test injection only; production generates a fresh ephemeral. */
  ephemeral?: NoiseKeyPair;
}

export interface NoiseResponderOptions {
  localStatic: NoiseKeyPair;
  prologue: Uint8Array;
  /** Test injection only; production generates a fresh ephemeral. */
  ephemeral?: NoiseKeyPair;
}

export interface TransportKeys {
  /** Initiator → responder. */
  send: CipherState;
  /** Responder → initiator. */
  receive: CipherState;
}

export interface NoiseHandshake {
  /** Builds the next handshake message this side is due to write. */
  writeMessage(payload: Uint8Array): Uint8Array;
  /** Consumes the next handshake message this side is due to read; returns its payload. */
  readMessage(message: Uint8Array): Uint8Array;
  /** True once both handshake messages have been processed. */
  isComplete(): boolean;
  handshakeHash(): Uint8Array;
  /** Derives transport keys, oriented for this side. Ends the handshake state. */
  split(): { send: CipherState; receive: CipherState };
}

type Token = "e" | "es" | "ee";
const NK_MESSAGES: ReadonlyArray<ReadonlyArray<Token>> = [
  ["e", "es"],
  ["e", "ee"],
];

export function generateNoiseKeyPair(): NoiseKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function createNoiseInitiator(options: NoiseInitiatorOptions): NoiseHandshake {
  requireKeyLength(options.remoteStatic, "remote static key");
  return new HandshakeState({
    initiator: true,
    prologue: options.prologue,
    s: null,
    rs: options.remoteStatic,
    ephemeral: options.ephemeral ?? null,
  });
}

export function createNoiseResponder(options: NoiseResponderOptions): NoiseHandshake {
  requireKeyLength(options.localStatic.publicKey, "local static public key");
  requireKeyLength(options.localStatic.secretKey, "local static secret key");
  return new HandshakeState({
    initiator: false,
    prologue: options.prologue,
    s: options.localStatic,
    rs: null,
    ephemeral: options.ephemeral ?? null,
  });
}

class HandshakeState implements NoiseHandshake {
  private readonly symmetric = new SymmetricState(NOISE_NK_PROTOCOL_NAME);
  private readonly initiator: boolean;
  private readonly s: NoiseKeyPair | null;
  private e: NoiseKeyPair | null;
  private rs: Uint8Array | null;
  private re: Uint8Array | null = null;
  private messageIndex = 0;
  private finished = false;

  constructor(params: {
    initiator: boolean;
    prologue: Uint8Array;
    s: NoiseKeyPair | null;
    rs: Uint8Array | null;
    ephemeral: NoiseKeyPair | null;
  }) {
    this.initiator = params.initiator;
    this.s = params.s;
    this.rs = params.rs;
    this.e = params.ephemeral;
    this.symmetric.mixHash(params.prologue);
    // Pre-message "<- s": the responder's static public key.
    const preMessageStatic = this.initiator ? this.rs : this.s?.publicKey;
    if (!preMessageStatic) throw new NoiseProtocolError("missing responder static key");
    this.symmetric.mixHash(preMessageStatic);
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    const tokens = this.nextTokens(this.initiator);
    const parts: Uint8Array[] = [];
    for (const token of tokens) {
      switch (token) {
        case "e": {
          if (!this.e) this.e = generateNoiseKeyPair();
          parts.push(this.e.publicKey);
          this.symmetric.mixHash(this.e.publicKey);
          break;
        }
        case "es":
          this.mixDh(this.initiator ? this.e : this.s, this.initiator ? this.rs : this.re);
          break;
        case "ee":
          this.mixDh(this.e, this.re);
          break;
      }
    }
    parts.push(this.symmetric.encryptAndHash(payload));
    const message = concat(...parts);
    if (message.byteLength > NOISE_MAX_MESSAGE_BYTES) {
      throw new NoiseProtocolError("handshake message too large");
    }
    this.advance();
    return message;
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (message.byteLength > NOISE_MAX_MESSAGE_BYTES) {
      throw new NoiseProtocolError("handshake message too large");
    }
    const tokens = this.nextTokens(!this.initiator);
    let offset = 0;
    for (const token of tokens) {
      switch (token) {
        case "e": {
          if (message.byteLength < offset + DH_BYTES) {
            throw new NoiseProtocolError("handshake message truncated");
          }
          this.re = message.slice(offset, offset + DH_BYTES);
          offset += DH_BYTES;
          this.symmetric.mixHash(this.re);
          break;
        }
        case "es":
          this.mixDh(this.initiator ? this.e : this.s, this.initiator ? this.rs : this.re);
          break;
        case "ee":
          this.mixDh(this.e, this.re);
          break;
      }
    }
    const payload = this.symmetric.decryptAndHash(message.slice(offset));
    this.advance();
    return payload;
  }

  isComplete(): boolean {
    return this.messageIndex >= NK_MESSAGES.length;
  }

  handshakeHash(): Uint8Array {
    return this.symmetric.handshakeHash();
  }

  split(): { send: CipherState; receive: CipherState } {
    if (!this.isComplete()) throw new NoiseProtocolError("handshake incomplete");
    if (this.finished) throw new NoiseProtocolError("handshake already split");
    this.finished = true;
    const [c1, c2] = this.symmetric.split();
    this.e?.secretKey.fill(0);
    this.e = null;
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }

  private nextTokens(expectedWriterIsInitiator: boolean): ReadonlyArray<Token> {
    if (this.isComplete() || this.finished) throw new NoiseProtocolError("handshake complete");
    const writerIsInitiator = this.messageIndex % 2 === 0;
    if (writerIsInitiator !== expectedWriterIsInitiator) {
      throw new NoiseProtocolError("handshake message out of turn");
    }
    return NK_MESSAGES[this.messageIndex];
  }

  private advance(): void {
    this.messageIndex += 1;
  }

  private mixDh(local: NoiseKeyPair | null, remote: Uint8Array | null): void {
    if (!local || !remote) throw new NoiseProtocolError("missing DH key");
    let shared: Uint8Array;
    try {
      shared = x25519.getSharedSecret(local.secretKey, remote);
    } catch {
      throw new NoiseProtocolError("invalid DH public key");
    }
    if (isAllZero(shared)) throw new NoiseProtocolError("invalid DH public key");
    this.symmetric.mixKey(shared);
    shared.fill(0);
  }
}

function requireKeyLength(key: Uint8Array, label: string): void {
  if (key.byteLength !== DH_BYTES) throw new NoiseProtocolError(`${label} must be 32 bytes`);
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}
