import type { AgentPermissionRequest } from "./agent-sdk-types.js";

/** Shared by every session of one agent so generations never go backwards. */
export interface PermissionLedger {
  agentId: string;
  generation: number;
  notify: (change: PermissionChange) => void;
}

export interface PermissionChange {
  agentId: string;
  sessionIncarnation: string;
  /** Generation after this change. */
  generation: number;
  change: "requested" | "resolved";
  requestId: string;
  kind: string;
}

/** Pending permissions of one live session; any membership change bumps the generation. */
export class TrackedPermissionMap extends Map<string, AgentPermissionRequest> {
  private readonly ledger: PermissionLedger;
  private readonly sessionIncarnation: string;

  constructor(ledger: PermissionLedger, sessionIncarnation: string) {
    super();
    this.ledger = ledger;
    this.sessionIncarnation = sessionIncarnation;
  }

  override set(requestId: string, request: AgentPermissionRequest): this {
    const isNew = !this.has(requestId);
    super.set(requestId, request);
    if (isNew) this.record("requested", requestId, request.kind);
    return this;
  }

  override delete(requestId: string): boolean {
    const existing = this.get(requestId);
    const removed = super.delete(requestId);
    if (removed && existing) this.record("resolved", requestId, existing.kind);
    return removed;
  }

  override clear(): void {
    for (const requestId of this.keys()) this.delete(requestId);
  }

  /** Reconcile to the provider's view, counting only requests that appeared or vanished. */
  replaceAll(requests: readonly AgentPermissionRequest[]): void {
    const next = new Map(requests.map((request) => [request.id, request]));
    for (const requestId of this.keys()) {
      if (!next.has(requestId)) this.delete(requestId);
    }
    for (const [requestId, request] of next) this.set(requestId, request);
  }

  private record(change: PermissionChange["change"], requestId: string, kind: string): void {
    this.ledger.generation += 1;
    this.ledger.notify({
      agentId: this.ledger.agentId,
      sessionIncarnation: this.sessionIncarnation,
      generation: this.ledger.generation,
      change,
      requestId,
      kind,
    });
  }
}
