import type { z } from "zod";
import type { OrderSetRequestSchema, OrderSetResponseSchema } from "@getpaseo/protocol/ordering";
import { orderScopeKey, type OrderRecord, type OrderScope } from "@getpaseo/protocol/ordering";
import { applyOrderMove, type OrderMove, type OrderAnchor } from "./move";
export type SetOrderInput = Omit<z.infer<typeof OrderSetRequestSchema>, "type" | "requestId">;
export type SetOrderResult = Omit<z.infer<typeof OrderSetResponseSchema>["payload"], "requestId">;
export interface OrderingPort {
  setOrder(input: SetOrderInput): Promise<SetOrderResult>;
}
export class OrderConflictError extends Error {
  constructor() {
    super("Order is still pending after repeated conflicts");
    this.name = "OrderConflictError";
  }
}
export type OrderMembership = ReadonlySet<string> | "pending" | "all";
export class OrderItemsRemovedError extends Error {
  constructor(readonly keys: readonly string[]) {
    super("Pending order items are no longer available in this scope");
    this.name = "OrderItemsRemovedError";
  }
}
export interface PendingOrder {
  scope: OrderScope;
  moves: OrderMove[];
}
export interface OrderReplicaInput {
  port: OrderingPort;
  membership: (scope: OrderScope) => OrderMembership;
  apply: (records: readonly OrderRecord[]) => void;
  failed: (error: unknown) => void;
}
interface PreparedOrder {
  moves: OrderMove[];
  request: SetOrderInput;
}
export interface ReorderInput {
  scope: OrderScope;
  move: OrderMove;
}
/** Pending operations outlive sockets until acknowledged or explicitly cancelled by authority. */
export class OrderReplica {
  private records = new Map<string, OrderRecord>();
  private readonly pending = new Map<string, PendingOrder>();
  private readonly inFlight = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private ready = false;
  private generation = 0;
  constructor(private readonly input: OrderReplicaInput) {}
  snapshot(records: readonly OrderRecord[]): void {
    this.records = new Map(records.map((record) => [orderScopeKey(record.scope), record]));
    this.ready = true;
    this.blocked.clear();
    this.reapply();
    for (const key of this.pending.keys()) void this.flush(key);
  }
  retry(): void {
    this.blocked.clear();
    for (const key of this.pending.keys()) void this.flush(key);
  }
  pause(): void {
    this.ready = false;
    this.generation++;
    this.inFlight.clear();
  }
  cancelPending(): boolean {
    if (this.pending.size === 0) return false;
    this.generation++;
    this.inFlight.clear();
    this.pending.clear();
    this.blocked.clear();
    this.reapply();
    return true;
  }
  receive(scope: OrderScope, record: OrderRecord | null): void {
    const key = orderScopeKey(scope);
    const current = this.records.get(key);
    if (record && current && record.revision < current.revision) return;
    if (record) this.records.set(key, record);
    else this.records.delete(key);
    this.reapply();
  }
  reapply(): void {
    if (!this.ready) return;
    this.input.apply(
      [...this.records].filter(([key]) => !this.pending.has(key)).map(([, record]) => record),
    );
  }
  reorder({ scope, move }: ReorderInput): void {
    const key = orderScopeKey(scope);
    const pending = this.pending.get(key) ?? { scope, moves: [] };
    pending.moves.push(move);
    this.pending.set(key, pending);
    this.blocked.delete(key);
    void this.flush(key);
  }
  private prune(pending: PendingOrder, members: ReadonlySet<string>): void {
    const removed = new Set<string>();
    pending.moves = pending.moves.flatMap((move) => {
      if (!members.has(move.moved)) {
        removed.add(move.moved);
        return [];
      }
      const anchors = [move.anchor, ...move.alternatives].filter((anchor) => {
        if ("kind" in anchor) return true;
        const id = "before" in anchor ? anchor.before : anchor.after;
        if (members.has(id)) return true;
        removed.add(id);
        return false;
      });
      const anchor: OrderAnchor = anchors[0] ?? { kind: "end" };
      return [
        {
          ...move,
          anchor,
          alternatives: anchors.slice(1),
          initialOrder: move.initialOrder.filter((id) => members.has(id)),
        },
      ];
    });
    if (removed.size) this.input.failed(new OrderItemsRemovedError([...removed]));
  }
  private prepare(key: string, pending: PendingOrder): PreparedOrder | null {
    const membership = this.input.membership(pending.scope);
    if (membership === "pending") {
      this.blocked.add(key);
      return null;
    }
    if (membership !== "all") this.prune(pending, membership);
    if (pending.moves.length === 0) {
      this.pending.delete(key);
      return null;
    }
    const moves = pending.moves.slice();
    const current = this.records.get(key);
    // Only a gesture can seed an uninitialized scope. A CAS loser replays moves on the winner.
    const initial = (current?.revision ?? 0) === 0 ? moves[0]!.initialOrder : current!.order;
    const base = membership === "all" ? initial : initial.filter((id) => membership.has(id));
    return {
      moves,
      request: {
        scope: pending.scope,
        expectedRevision: current?.revision ?? 0,
        order: moves.reduce(applyOrderMove, base),
      },
    };
  }
  private async flush(key: string): Promise<void> {
    if (!this.ready || this.inFlight.has(key) || this.blocked.has(key)) return;
    const pending = this.pending.get(key);
    if (!pending) return;
    if (this.input.membership(pending.scope) === "pending") return;
    const generation = this.generation;
    this.inFlight.set(key, generation);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const prepared = this.prepare(key, pending);
        if (!prepared) return;
        const { moves, request } = prepared;
        const result = await this.input.port.setOrder(request);
        if (generation !== this.generation) return;
        const latest = this.records.get(key);
        if (!latest || result.record.revision >= latest.revision)
          this.records.set(key, result.record);
        if (!result.accepted) continue;
        // A later broadcast includes a previously accepted move. Replaying that move would undo the later writer.
        pending.moves.splice(0, moves.length);
        if (pending.moves.length === 0) this.pending.delete(key);
        return;
      }
      this.blocked.add(key);
      this.input.failed(new OrderConflictError());
    } catch (error) {
      if (generation === this.generation) {
        this.blocked.add(key);
        this.input.failed(error);
      }
    } finally {
      if (this.inFlight.get(key) === generation) this.inFlight.delete(key);
      this.reapply();
      if (this.pending.has(key) && !this.blocked.has(key)) void this.flush(key);
    }
  }
}
