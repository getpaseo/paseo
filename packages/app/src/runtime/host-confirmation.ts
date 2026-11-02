import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import {
  hostHasConnection,
  relayConnectionFromOffer,
  type HostProfile,
} from "@/types/host-connection";

/**
 * The question shown before a pairing link adds a host that is not saved, or
 * changes the key, relay, or TLS setting of a saved one.
 */
export interface HostConfirmationRequest {
  /** Identifies this question, so an answer shown for it never answers a newer one. */
  id: number;
  serverId: string;
  /** Grouped daemon public key the user can compare with the one their daemon shows. */
  keyFingerprint: string;
  relayEndpoint: string;
  kind: "newHost" | "changedConnection";
}

interface PendingConfirmation {
  request: HostConfirmationRequest;
  resolve: (approved: boolean) => void;
}

/**
 * Owns the one host confirmation the app is waiting on. The host runtime asks
 * through `confirmLink`; the view reads `getPending` and replies with `answer`.
 * A question waits until it is answered, whether or not a view is showing it.
 */
export class HostConfirmations {
  private pending: PendingConfirmation | null = null;
  private nextRequestId = 1;
  private listeners = new Set<() => void>();

  getPending(): HostConfirmationRequest | null {
    return this.pending?.request ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Answers the request with `requestId`; an answer for any other request is ignored. */
  answer(requestId: number, approved: boolean): void {
    const current = this.pending;
    if (!current || current.request.id !== requestId) return;
    this.pending = null;
    this.emit();
    current.resolve(approved);
  }

  /** Resolves true without asking when the link matches a saved host exactly. */
  confirmLink(offer: ConnectionOffer, savedHosts: HostProfile[]): Promise<boolean> {
    const connection = relayConnectionFromOffer(offer);
    const savedHost = savedHosts.find((host) => host.serverId === offer.serverId);
    if (savedHost && hostHasConnection(savedHost, connection)) return Promise.resolve(true);
    return this.ask({
      id: this.nextRequestId++,
      serverId: offer.serverId,
      keyFingerprint: formatDaemonKeyFingerprint(connection.daemonPublicKeyB64),
      relayEndpoint: connection.relayEndpoint,
      kind: savedHost ? "changedConnection" : "newHost",
    });
  }

  private ask(request: HostConfirmationRequest): Promise<boolean> {
    // One question at a time: a newer one cancels the unanswered one.
    this.pending?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending = { request, resolve };
      this.emit();
    });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * Shows the key material itself (not a re-hash) in groups of four. Keys longer
 * than 16 characters show only their first and last 8, so two keys that share
 * both ends show the same value.
 */
function formatDaemonKeyFingerprint(daemonPublicKeyB64: string): string {
  const normalized = daemonPublicKeyB64.replace(/[^A-Za-z0-9]/g, "");
  const group = (value: string): string => value.replace(/(.{4})/g, "$1 ").trim();
  if (normalized.length <= 16) return group(normalized);
  return `${group(normalized.slice(0, 8))} … ${group(normalized.slice(-8))}`;
}
