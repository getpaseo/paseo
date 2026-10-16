import { orderScopeKey, type OrderRecord, type OrderScope } from "@getpaseo/protocol/ordering";

export interface OrderingPort {
  setOrder(input: {
    scope: OrderScope;
    expectedRevision: number;
    order: string[];
  }): Promise<{ accepted: boolean; record: OrderRecord }>;
}
export class OrderConflictError extends Error {
  constructor() {
    super("Another device changed the order");
    this.name = "OrderConflictError";
  }
}

interface PendingOrder {
  scope: OrderScope;
  order: string[];
}

/** Only explicit gestures write. Snapshots and echoes cannot publish the local cache. */
export class OrderReplica {
  private records = new Map<string, OrderRecord>();
  private readonly pending = new Map<string, PendingOrder>();
  private readonly inFlight = new Set<string>();
  private ready = false;
  private disposed = false;

  constructor(
    private readonly port: OrderingPort,
    private readonly apply: (records: readonly OrderRecord[]) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  snapshot(records: readonly OrderRecord[]): void {
    if (this.disposed) return;
    this.records = new Map(records.map((record) => [orderScopeKey(record.scope), record]));
    this.ready = true;
    this.reapply();
  }

  receive(scope: OrderScope, record: OrderRecord | null): void {
    if (this.disposed) return;
    const key = orderScopeKey(scope);
    const current = this.records.get(key);
    if (record && current && record.revision < current.revision) return;
    if (record) this.records.set(key, record);
    else this.records.delete(key);
    this.reapply();
  }

  reapply(): void {
    if (!this.ready || this.disposed) return;
    this.apply(
      [...this.records]
        .filter(([key]) => !this.pending.has(key) && !this.inFlight.has(key))
        .map(([, record]) => record),
    );
  }

  order(scope: OrderScope): readonly string[] {
    return this.records.get(orderScopeKey(scope))?.order ?? [];
  }

  reorder(scope: OrderScope, order: string[]): void {
    if (!this.ready || this.disposed) return;
    const key = orderScopeKey(scope);
    this.pending.set(key, { scope, order });
    void this.flush(key);
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
  }

  private async flush(key: string): Promise<void> {
    if (this.inFlight.has(key) || this.disposed) return;
    const intent = this.pending.get(key);
    if (!intent) return;
    this.pending.delete(key);
    this.inFlight.add(key);
    try {
      const result = await this.port.setOrder({
        ...intent,
        expectedRevision: this.records.get(key)?.revision ?? 0,
      });
      if (this.disposed) return;
      const current = this.records.get(key);
      if (!current || result.record.revision >= current.revision)
        this.records.set(key, result.record);
      // A conflicting gesture loses to the daemon authority; never replay it with a fresh revision.
      if (!result.accepted || (current && current.revision > result.record.revision)) {
        this.pending.delete(key);
        this.failed(new OrderConflictError());
      }
    } catch (error) {
      if (!this.disposed) {
        this.pending.delete(key);
        this.failed(error);
      }
    } finally {
      this.inFlight.delete(key);
      if (!this.disposed) {
        this.reapply();
        if (this.pending.has(key)) void this.flush(key);
      }
    }
  }
}
