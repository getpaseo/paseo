import type pino from "pino";
import type { DaemonPermission } from "../authorization/index.js";
import {
  NetworkTunnelTicketStore,
  type IssuedTunnelTicket,
  type NetworkTunnelTicketStoreOptions,
  type TunnelTicketIdentity,
} from "./internal/ticket-store.js";
import type { HostResolver } from "./internal/destination-policy.js";
import { TunnelSession, type TunnelSocketLike } from "./internal/tunnel-session.js";

export type { IssuedTunnelTicket, TunnelSocketLike, TunnelTicketIdentity };

export interface NetworkTunnelServiceOptions {
  ticketStore?: NetworkTunnelTicketStoreOptions;
  maxConcurrentStreams?: number;
  maxFramePayloadBytes?: number;
  initialStreamWindowBytes?: number;
  initialConnectionWindowBytes?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
  resolveHost?: HostResolver;
}

export class NetworkTunnelService {
  private readonly tickets: NetworkTunnelTicketStore;
  private readonly activeSessions = new Set<TunnelSession>();
  private readonly options: NetworkTunnelServiceOptions;

  constructor(options: NetworkTunnelServiceOptions = {}) {
    this.options = options;
    this.tickets = new NetworkTunnelTicketStore(options.ticketStore);
  }

  get activeSessionCount(): number {
    return this.activeSessions.size;
  }

  createTicket(identity: {
    principalId: string;
    permissions: readonly DaemonPermission[];
  }): IssuedTunnelTicket {
    return this.tickets.issue(identity);
  }

  redeemTicket(ticket: string): TunnelTicketIdentity | null {
    return this.tickets.redeem(ticket);
  }

  attachTunnelSocket(
    ws: TunnelSocketLike,
    params: {
      principalId: string;
      logger: pino.Logger;
    },
  ): TunnelSession {
    const session = new TunnelSession({
      ws,
      principalId: params.principalId,
      logger: params.logger,
      maxConcurrentStreams: this.options.maxConcurrentStreams,
      maxFramePayloadBytes: this.options.maxFramePayloadBytes,
      initialStreamWindowBytes: this.options.initialStreamWindowBytes,
      initialConnectionWindowBytes: this.options.initialConnectionWindowBytes,
      connectTimeoutMs: this.options.connectTimeoutMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
      idleCheckIntervalMs: this.options.idleCheckIntervalMs,
      resolveHost: this.options.resolveHost,
      onClose: () => {
        this.activeSessions.delete(session);
      },
    });
    if (!session.isClosed) {
      this.activeSessions.add(session);
    }
    return session;
  }

  revokePrincipal(principalId: string): void {
    this.tickets.revokePrincipal(principalId);
    for (const session of Array.from(this.activeSessions)) {
      if (session.principalId === principalId) {
        session.close(4401, "Tunnel permission revoked");
      }
    }
  }

  close(): void {
    this.tickets.clear();
    for (const session of Array.from(this.activeSessions)) {
      session.close(1001, "Server shutting down");
    }
    this.activeSessions.clear();
  }
}
