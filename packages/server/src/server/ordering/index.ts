import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  OrderRecordSchema,
  OrderTargetsSetRequestSchema,
  OrderSetRequestSchema,
  OrderSetResponseSchema,
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
export type OrderSetInput = Omit<z.infer<typeof OrderSetRequestSchema>, "type" | "requestId">;
export type OrderSetResult = Omit<z.infer<typeof OrderSetResponseSchema>["payload"], "requestId">;
export interface OrderingServiceInput {
  filePath: string;
  validate: (input: OrderSetInput) => Promise<void>;
  write?: typeof writeJsonFileAtomic;
}
export interface OrderDevice {
  principalId: string;
  clientId: string;
}
export interface OrderDeviceLease extends OrderDevice {
  epoch: number;
}
export interface OrderPruneSnapshot {
  projectIds: ReadonlySet<string>;
  workspaceIds: ReadonlySet<string>;
  pinnedWorkspaceIds: ReadonlySet<string>;
}
export interface OrderPruneInput {
  load: () => Promise<OrderPruneSnapshot>;
}
export interface OrderSubscriptionInput {
  principalId: string;
  listener: (change: OrderChange) => void;
}
export interface AuthorizedOrderSetInput extends OrderSetInput {
  principalId: string;
  device?: OrderDeviceLease;
}
export interface OrderTargetsInput extends Omit<
  z.infer<typeof OrderTargetsSetRequestSchema>,
  "type" | "requestId"
> {
  device: OrderDeviceLease;
}
const DeviceSchema = z.object({
  principalId: z.string(),
  clientId: z.string(),
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  workspaces: OrderTargetsSetRequestSchema.shape.workspaces,
});
const PrincipalSchema = z.object({ principalId: z.string(), records: z.array(OrderRecordSchema) });
const StateSchema = z.object({
  principals: z.array(PrincipalSchema),
  devices: z.array(DeviceSchema),
});
type State = z.infer<typeof StateSchema>;
type Device = z.infer<typeof DeviceSchema>;
export class OrderDeviceForgottenError extends Error {
  constructor() {
    super("Device ordering preferences were forgotten; reconnect to register again");
    this.name = "OrderDeviceForgottenError";
  }
}
export class OrderingService {
  private state: State = { principals: [], devices: [] };
  private readonly listeners = new Set<OrderSubscriptionInput>();
  private queue: Promise<void> = Promise.resolve();
  private readonly write: typeof writeJsonFileAtomic;
  constructor(private readonly input: OrderingServiceInput) {
    this.write = input.write ?? writeJsonFileAtomic;
  }
  async initialize(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.input.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    // COMPAT(sharedOrderingStorage): added in v0.11.x, remove after 2027-04-17 once persisted arrays have upgraded.
    this.state = Array.isArray(value)
      ? {
          principals: [{ principalId: "owner", records: z.array(OrderRecordSchema).parse(value) }],
          devices: [],
        }
      : StateSchema.parse(value);
  }
  list(principalId: string): OrderRecord[] {
    return structuredClone(this.records(principalId));
  }
  lease(device: OrderDevice): OrderDeviceLease {
    return { ...device, epoch: this.device(device)?.epoch ?? 0 };
  }
  deviceRevision(device: OrderDevice): number {
    return this.device(device)?.revision ?? 0;
  }
  subscribe(input: OrderSubscriptionInput) {
    this.listeners.add(input);
    return {
      records: this.list(input.principalId),
      unsubscribe: () => {
        this.listeners.delete(input);
      },
    };
  }
  set(input: AuthorizedOrderSetInput): Promise<OrderSetResult> {
    return this.serialize(async () => {
      if (input.device) this.assertLease(input.device);
      await this.input.validate(input);
      const current = this.records(input.principalId).find(
        (r) => orderScopeKey(r.scope) === orderScopeKey(input.scope),
      ) ?? { scope: input.scope, revision: 0, order: [] };
      if (current.revision !== input.expectedRevision)
        return { accepted: false, record: structuredClone(current) };
      let order = [...new Set(input.order)];
      if (input.scope.kind === "tabs") {
        const held = this.targets(this.state, input.principalId, input.scope.workspaceId);
        order = order.filter((key) => held.has(key));
      }
      if (ordersEqual(current.order, order))
        return { accepted: true, record: structuredClone(current) };
      const record = OrderRecordSchema.parse({
        scope: input.scope,
        revision: current.revision + 1,
        order,
      });
      const next = structuredClone(this.state);
      const records = this.ensureRecords(next, input.principalId);
      const index = records.findIndex((r) => orderScopeKey(r.scope) === orderScopeKey(input.scope));
      if (index < 0) records.push(record);
      else records[index] = record;
      await this.commit(next);
      return { accepted: true, record: structuredClone(record) };
    });
  }
  setTargets(input: OrderTargetsInput) {
    return this.serialize(async () => {
      this.assertLease(input.device);
      const current = this.device(input.device);
      const revision = current?.revision ?? 0;
      if (revision !== input.expectedRevision) return { accepted: false, revision };
      for (const workspace of input.workspaces)
        await this.input.validate({
          scope: { kind: "tabs", workspaceId: workspace.workspaceId },
          expectedRevision: 0,
          order: workspace.targets,
        });
      const next = structuredClone(this.state);
      const device: Device = {
        ...input.device,
        revision: revision + 1,
        workspaces: input.workspaces.map((workspace) => ({
          ...workspace,
          targets: [...new Set(workspace.targets)],
        })),
      };
      this.replaceDevice(next, device);
      this.pruneTargets(next, input.device.principalId);
      await this.commit(next);
      return { accepted: true, revision: device.revision };
    });
  }
  forgetDevice(device: OrderDevice): Promise<void> {
    return this.serialize(async () => {
      const current = this.device(device);
      const next = structuredClone(this.state);
      // A durable epoch fences every source that observed the previous registration.
      this.replaceDevice(next, {
        ...device,
        epoch: (current?.epoch ?? 0) + 1,
        revision: (current?.revision ?? 0) + 1,
        workspaces: [],
      });
      this.pruneTargets(next, device.principalId);
      await this.commit(next);
    });
  }
  prune(input: OrderPruneInput): Promise<void> {
    return this.serialize(async () => {
      const snapshot = await input.load();
      const next = structuredClone(this.state);
      for (const principal of next.principals) {
        principal.records = principal.records.flatMap((record) => {
          const scope = record.scope;
          if (scope.kind === "tabs")
            return snapshot.workspaceIds.has(scope.workspaceId) ? [record] : [];
          if (scope.kind === "workspaces" && !snapshot.projectIds.has(scope.projectId)) return [];
          const available =
            scope.kind === "pinned" ? snapshot.pinnedWorkspaceIds : snapshot.workspaceIds;
          const order = record.order.filter((id) => available.has(id));
          return [
            ordersEqual(order, record.order)
              ? record
              : { ...record, order, revision: record.revision + 1 },
          ];
        });
      }
      for (const device of next.devices)
        device.workspaces = device.workspaces.filter((workspace) =>
          snapshot.workspaceIds.has(workspace.workspaceId),
        );
      if (JSON.stringify(next) !== JSON.stringify(this.state)) await this.commit(next);
    });
  }
  private records(principalId: string): OrderRecord[] {
    return this.state.principals.find((p) => p.principalId === principalId)?.records ?? [];
  }
  private ensureRecords(state: State, principalId: string): OrderRecord[] {
    let principal = state.principals.find((p) => p.principalId === principalId);
    if (!principal) {
      principal = { principalId, records: [] };
      state.principals.push(principal);
    }
    return principal.records;
  }
  private device(device: OrderDevice): Device | undefined {
    return this.state.devices.find(
      (d) => d.principalId === device.principalId && d.clientId === device.clientId,
    );
  }
  private assertLease(device: OrderDeviceLease): void {
    if ((this.device(device)?.epoch ?? 0) !== device.epoch) throw new OrderDeviceForgottenError();
  }
  private replaceDevice(state: State, device: Device): void {
    const index = state.devices.findIndex(
      (d) => d.principalId === device.principalId && d.clientId === device.clientId,
    );
    if (index < 0) state.devices.push(device);
    else state.devices[index] = device;
  }
  private targets(state: State, principalId: string, workspaceId: string): Set<string> {
    return new Set(
      state.devices
        .filter((d) => d.principalId === principalId)
        .flatMap((d) =>
          d.workspaces.filter((w) => w.workspaceId === workspaceId).flatMap((w) => w.targets),
        ),
    );
  }
  private pruneTargets(state: State, principalId: string): void {
    const records = this.ensureRecords(state, principalId);
    for (const record of records) {
      if (record.scope.kind !== "tabs") continue;
      const held = this.targets(state, principalId, record.scope.workspaceId);
      const order = record.order.filter((key) => held.has(key));
      if (!ordersEqual(order, record.order)) {
        record.order = order;
        record.revision++;
      }
    }
  }
  private async commit(next: State): Promise<void> {
    await this.write(this.input.filePath, next);
    const previous = this.state;
    this.state = next;
    for (const subscription of this.listeners) {
      const before =
        previous.principals.find((p) => p.principalId === subscription.principalId)?.records ?? [];
      const after = this.records(subscription.principalId);
      for (const record of after) {
        const old = before.find((r) => orderScopeKey(r.scope) === orderScopeKey(record.scope));
        if (old?.revision !== record.revision)
          subscription.listener({ scope: record.scope, record: structuredClone(record) });
      }
      for (const record of before)
        if (!after.some((r) => orderScopeKey(r.scope) === orderScopeKey(record.scope)))
          subscription.listener({ scope: record.scope, record: null });
    }
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
