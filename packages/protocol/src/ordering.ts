import { z } from "zod";

const IdSchema = z.string().min(1).max(4096);
export const OrderScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspaces"), projectId: IdSchema }),
  z.object({ kind: z.literal("tabs"), workspaceId: IdSchema }),
  z.object({ kind: z.literal("pinned") }),
]);
export const OrderRecordSchema = z.object({
  scope: OrderScopeSchema,
  revision: z.number().int().nonnegative(),
  order: z.array(IdSchema).max(4096),
});
export type OrderScope = z.infer<typeof OrderScopeSchema>;
export type OrderRecord = z.infer<typeof OrderRecordSchema>;

export function orderScopeKey(scope: OrderScope): string {
  switch (scope.kind) {
    case "workspaces":
      return JSON.stringify([scope.kind, scope.projectId]);
    case "tabs":
      return JSON.stringify([scope.kind, scope.workspaceId]);
    case "pinned":
      return JSON.stringify([scope.kind]);
  }
}

/** Reorder the shared subset in place; retain device-only entries and their slots. */
export function applySharedOrder(current: readonly string[], order: readonly string[]): string[] {
  const present = new Set(current);
  const shared = [...new Set(order)].filter((key) => present.has(key));
  const selected = new Set(shared);
  const counts = new Map<string, number>();
  for (const key of current) counts.set(key, (counts.get(key) ?? 0) + 1);
  const expanded = shared.flatMap((key) => Array<string>(counts.get(key)!).fill(key));
  let index = 0;
  return current.map((key) => (selected.has(key) ? expanded[index++]! : key));
}

export function ordersEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export const OrderListRequestSchema = z.object({
  type: z.literal("ui.order.list.request"),
  requestId: z.string(),
  subscribe: z.object({ subscriptionId: z.string().optional() }).optional(),
});
export const OrderSetRequestSchema = z.object({
  type: z.literal("ui.order.set.request"),
  requestId: z.string(),
  scope: OrderScopeSchema,
  expectedRevision: z.number().int().nonnegative(),
  order: z.array(IdSchema).max(4096),
});
export const OrderListResponseSchema = z.object({
  type: z.literal("ui.order.list.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    records: z.array(OrderRecordSchema),
    deviceRevision: z.number().int().nonnegative().optional(),
  }),
});
export const OrderSetResponseSchema = z.object({
  type: z.literal("ui.order.set.response"),
  payload: z.object({ requestId: z.string(), accepted: z.boolean(), record: OrderRecordSchema }),
});
export const OrderUpdateSchema = z.object({
  type: z.literal("ui.order.update"),
  payload: z.object({
    subscriptionId: z.string().optional(),
    scope: OrderScopeSchema,
    record: OrderRecordSchema.nullable(),
  }),
});

export const OrderTargetsSetRequestSchema = z.object({
  type: z.literal("ui.order.targets.set.request"),
  requestId: z.string(),
  expectedRevision: z.number().int().nonnegative(),
  workspaces: z.array(z.object({ workspaceId: IdSchema, targets: z.array(IdSchema) })),
});
export const OrderTargetsSetResponseSchema = z.object({
  type: z.literal("ui.order.targets.set.response"),
  payload: z.object({
    requestId: z.string(),
    accepted: z.boolean(),
    revision: z.number().int().nonnegative(),
  }),
});
export const OrderDeviceForgetRequestSchema = z.object({
  type: z.literal("ui.order.devices.forget.request"),
  requestId: z.string(),
  clientId: z.string().optional(),
});
export const OrderDeviceForgetResponseSchema = z.object({
  type: z.literal("ui.order.devices.forget.response"),
  payload: z.object({ requestId: z.string() }),
});
