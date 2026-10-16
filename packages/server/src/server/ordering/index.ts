import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  OrderRecordSchema,
  orderScopeKey,
  ordersEqual,
  type OrderRecord,
  type OrderScope,
} from "@getpaseo/protocol/ordering";
import { writeJsonFileAtomic } from "../atomic-file.js";

export interface OrderChange {
  scope: OrderScope;
  record: OrderRecord | null;
}
export interface OrderSetInput {
  scope: OrderScope;
  expectedRevision: number;
  order: string[];
}
export interface OrderSetResult {
  accepted: boolean;
  record: OrderRecord;
}

/** One daemon authority. Persist before publication; revisions compare within each scope. */
export class OrderingService {
  private records = new Map<string, OrderRecord>();
  private readonly listeners = new Set<(change: OrderChange) => void>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly validate: (input: OrderSetInput) => Promise<void>,
    private readonly write: (path: string, value: unknown) => Promise<void> = writeJsonFileAtomic,
  ) {}

  async initialize(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const records = z.array(OrderRecordSchema).parse(JSON.parse(raw));
    this.records = new Map(records.map((record) => [orderScopeKey(record.scope), record]));
  }

  list(): OrderRecord[] {
    return structuredClone([...this.records.values()]);
  }

  subscribe(listener: (change: OrderChange) => void): {
    records: OrderRecord[];
    unsubscribe: () => void;
  } {
    this.listeners.add(listener);
    return {
      records: this.list(),
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  set(input: OrderSetInput): Promise<OrderSetResult> {
    return this.serialize(async () => {
      await this.validate(input);
      const key = orderScopeKey(input.scope);
      const current = this.records.get(key) ?? { scope: input.scope, revision: 0, order: [] };
      if (current.revision !== input.expectedRevision)
        return { accepted: false, record: structuredClone(current) };
      const order = [...new Set(input.order)];
      if (ordersEqual(current.order, order))
        return { accepted: true, record: structuredClone(current) };
      const record = { scope: input.scope, revision: current.revision + 1, order };
      const next = new Map(this.records).set(key, record);
      await this.commit(next, [{ scope: record.scope, record }]);
      return { accepted: true, record: structuredClone(record) };
    });
  }

  removePinned(workspaceId: string): Promise<void> {
    return this.serialize(async () => {
      const key = orderScopeKey({ kind: "pinned" });
      const current = this.records.get(key);
      if (!current?.order.includes(workspaceId)) return;
      const record = {
        ...current,
        revision: current.revision + 1,
        order: current.order.filter((id) => id !== workspaceId),
      };
      await this.commit(new Map(this.records).set(key, record), [{ scope: record.scope, record }]);
    });
  }

  prune(input: {
    projectIds: ReadonlySet<string>;
    workspaceIds: ReadonlySet<string>;
  }): Promise<void> {
    return this.serialize(async () => {
      const next = new Map(this.records);
      const changes: OrderChange[] = [];
      for (const [key, record] of this.records) {
        const scope = record.scope;
        const removed =
          scope.kind === "workspaces"
            ? !input.projectIds.has(scope.projectId)
            : scope.kind === "tabs" && !input.workspaceIds.has(scope.workspaceId);
        if (removed) {
          next.delete(key);
          changes.push({ scope, record: null });
        } else if (scope.kind !== "tabs") {
          const order = record.order.filter((id) => input.workspaceIds.has(id));
          if (ordersEqual(order, record.order)) continue;
          const updated = { ...record, order, revision: record.revision + 1 };
          next.set(key, updated);
          changes.push({ scope, record: updated });
        }
      }
      if (changes.length) await this.commit(next, changes);
    });
  }

  private async commit(next: Map<string, OrderRecord>, changes: OrderChange[]): Promise<void> {
    await this.write(this.filePath, [...next.values()]);
    this.records = next;
    for (const change of changes)
      for (const listener of this.listeners) listener(structuredClone(change));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
