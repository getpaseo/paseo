import type { z } from "zod";
import type { OrderSetRequestSchema, OrderSetResponseSchema } from "@getpaseo/protocol/ordering";
import { orderScopeKey, type OrderRecord, type OrderScope } from "@getpaseo/protocol/ordering";
import { applyOrderMove, type OrderMove } from "./move";
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
export interface PendingOrder {
  scope: OrderScope;
  moves: OrderMove[];
}
export interface OrderReplicaInput {
  port: OrderingPort;
  apply: (records: readonly OrderRecord[]) => void;
  failed: (error: unknown) => void;
}
export interface ReorderInput {
  scope: OrderScope;
  move: OrderMove;
}
/** Pending operations outlive sockets. Only acknowledgements remove operations. */
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
  private async flush(key: string): Promise<void> {
    if (!this.ready || this.inFlight.has(key) || this.blocked.has(key)) return;
    const pending = this.pending.get(key);
    if (!pending) return;
    const generation = this.generation;
    this.inFlight.set(key, generation);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const moves = pending.moves.slice();
        const current = this.records.get(key);
        const base = current?.order ?? [];
        const order = moves.reduce(applyOrderMove, base);
        const result = await this.input.port.setOrder({
          scope: pending.scope,
          expectedRevision: current?.revision ?? 0,
          order,
        });
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
