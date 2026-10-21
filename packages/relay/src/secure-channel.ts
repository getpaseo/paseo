/// <reference lib="dom" />
/**
 * Endpoint security for relay-carried daemon sessions.
 *
 * This is the one entrypoint both endpoints use to secure a transport. It owns
 * the handshake, record protection, retries, termination, and the negotiated
 * security mode. Relay adapters own routing and physical I/O; daemon admission
 * owns credentials and authorization.
 *
 * "legacy" is the pre-existing ephemeral-static box construction in
 * `encrypted-channel.ts`. It has no replay protection.
 */

import {
  createClientChannel,
  createDaemonChannel,
  type EncryptedChannelEvents,
  type Transport,
} from "./encrypted-channel.js";
import type { KeyPair } from "./crypto.js";

export type SecurityMode = "legacy";

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
  events?: SecureChannelEvents;
}

export interface DaemonSecureChannelOptions {
  daemonKeyPair: KeyPair;
  events?: SecureChannelEvents;
}

/**
 * Secures a transport as the initiator. Resolves once the handshake has been
 * started; `events.onopen` fires when the channel is usable.
 */
export async function openClientSecureChannel(
  transport: Transport,
  options: ClientSecureChannelOptions,
): Promise<SecureChannel> {
  const channel = await createClientChannel(transport, options.daemonPublicKeyB64, options.events);
  return withSecurityMode(channel, "legacy");
}

/**
 * Secures a transport as the responder. Resolves once the peer's handshake has
 * been accepted and the channel is open.
 */
export async function openDaemonSecureChannel(
  transport: Transport,
  options: DaemonSecureChannelOptions,
): Promise<SecureChannel> {
  const channel = await createDaemonChannel(transport, options.daemonKeyPair, options.events);
  return withSecurityMode(channel, "legacy");
}

function withSecurityMode(
  channel: Omit<SecureChannel, "securityMode">,
  mode: SecurityMode,
): SecureChannel {
  return {
    send: (data) => channel.send(data),
    close: (code, reason) => channel.close(code, reason),
    isOpen: () => channel.isOpen(),
    securityMode: () => mode,
    outboundWireByteLength: (data) => channel.outboundWireByteLength(data),
    onTransitionToOpen: (cb) => channel.onTransitionToOpen(cb),
    onClose: (cb) => channel.onClose(cb),
  };
}
