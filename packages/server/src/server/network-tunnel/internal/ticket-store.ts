import { randomBytes } from "node:crypto";
import type { DaemonPermission } from "../../authorization/index.js";

export const DEFAULT_TUNNEL_TICKET_TTL_MS = 30_000;
export const DEFAULT_MAX_TUNNEL_TICKETS = 1024;

export interface TunnelTicketIdentity {
  principalId: string;
  permissions: readonly DaemonPermission[];
}

export interface IssuedTunnelTicket {
  ticket: string;
  expiresAtMs: number;
}

interface StoredTunnelTicket extends TunnelTicketIdentity {
  expiresAtMs: number;
}

export interface NetworkTunnelTicketStoreOptions {
  ttlMs?: number;
  maxTickets?: number;
  clock?: () => number;
  generateToken?: () => string;
}

export class NetworkTunnelTicketStore {
  private readonly tickets = new Map<string, StoredTunnelTicket>();
  private readonly ttlMs: number;
  private readonly maxTickets: number;
  private readonly clock: () => number;
  private readonly generateToken: () => string;

  constructor(options: NetworkTunnelTicketStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TUNNEL_TICKET_TTL_MS;
    this.maxTickets = options.maxTickets ?? DEFAULT_MAX_TUNNEL_TICKETS;
    this.clock = options.clock ?? Date.now;
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  }

  get size(): number {
    return this.tickets.size;
  }

  issue(identity: TunnelTicketIdentity): IssuedTunnelTicket {
    const now = this.clock();
    this.purgeExpired(now);
    while (this.tickets.size >= this.maxTickets) {
      const oldestKey = this.tickets.keys().next().value;
      if (oldestKey === undefined) break;
      this.tickets.delete(oldestKey);
    }

    const ticket = this.generateToken();
    const expiresAtMs = now + this.ttlMs;
    this.tickets.set(ticket, {
      principalId: identity.principalId,
      permissions: [...identity.permissions],
      expiresAtMs,
    });
    return { ticket, expiresAtMs };
  }

  redeem(ticket: string): TunnelTicketIdentity | null {
    const stored = this.tickets.get(ticket);
    if (!stored) return null;
    // Single-use: always delete immediately upon lookup.
    this.tickets.delete(ticket);
    if (this.clock() >= stored.expiresAtMs) {
      return null;
    }
    return {
      principalId: stored.principalId,
      permissions: stored.permissions,
    };
  }

  revokePrincipal(principalId: string): void {
    for (const [ticket, stored] of this.tickets) {
      if (stored.principalId === principalId) {
        this.tickets.delete(ticket);
      }
    }
  }

  clear(): void {
    this.tickets.clear();
  }

  private purgeExpired(now: number): void {
    for (const [ticket, stored] of this.tickets) {
      if (now >= stored.expiresAtMs) {
        this.tickets.delete(ticket);
      }
    }
  }
}
