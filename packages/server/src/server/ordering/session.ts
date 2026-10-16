import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";
import type { OrderingService } from "./index.js";

export interface OrderingSessionInput {
  service: OrderingService;
  delivery: SessionDelivery;
  emit: (message: SessionOutboundMessage) => void;
  principalId: string;
  clientId: string;
}
export interface OrderingSessionDependency {
  service: OrderingService;
  principalId: string;
}
export interface CreateOrderingSessionInput extends Omit<
  OrderingSessionInput,
  "service" | "principalId"
> {
  ordering: OrderingSessionDependency | undefined;
}
export function createOrderingSession(input: CreateOrderingSessionInput): OrderingSession | null {
  if (!input.ordering) return null;
  return new OrderingSession({ ...input, ...input.ordering });
}
export class OrderingSession {
  private readonly leases = new WeakMap<object, ReturnType<OrderingService["lease"]>>();
  constructor(private readonly input: OrderingSessionInput) {}
  attach(source: object): void {
    if (this.leases.has(source)) return;
    this.leases.set(
      source,
      this.input.service.lease({
        principalId: this.input.principalId,
        clientId: this.input.clientId,
      }),
    );
  }
  private lease() {
    const source = this.input.delivery.currentSource;
    if (!source) throw new Error("Ordering has no requesting source");
    this.attach(source);
    return this.leases.get(source)!;
  }
  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "ui.order.list.request":
        return this.list(message);
      case "ui.order.targets.set.request":
        return this.mutate(message, async () => {
          const result = await this.input.service.setTargets({ ...message, device: this.lease() });
          this.input.emit({
            type: "ui.order.targets.set.response",
            payload: { requestId: message.requestId, ...result },
          });
        });
      case "ui.order.devices.forget.request":
        return this.mutate(message, async () => {
          await this.input.service.forgetDevice({
            principalId: this.input.principalId,
            clientId: message.clientId ?? this.input.clientId,
          });
          this.input.emit({
            type: "ui.order.devices.forget.response",
            payload: { requestId: message.requestId },
          });
        });
      case "ui.order.set.request":
        return this.set(message);
      default:
        return undefined;
    }
  }

  private async mutate(
    request: SessionInboundMessage & { requestId: string },
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.input.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          code: "order_update_failed",
          error: error instanceof Error ? error.message : "Order update failed",
        },
      });
    }
  }

  private async list(
    request: Extract<SessionInboundMessage, { type: "ui.order.list.request" }>,
  ): Promise<void> {
    if (!request.subscribe) {
      this.input.emit({
        type: "ui.order.list.response",
        payload: {
          requestId: request.requestId,
          records: this.input.service.list(this.input.principalId),
          deviceRevision: this.input.service.deviceRevision(this.lease()),
        },
      });
      return;
    }
    let unsubscribe: (() => void) | undefined;
    const owner = this.input.delivery.begin("ui-order", request.subscribe.subscriptionId, () =>
      unsubscribe?.(),
    );
    const subscription = this.input.service.subscribe({
      principalId: this.input.principalId,
      listener: (change) => {
        owner.emit({ type: "ui.order.update", payload: change });
      },
    });
    unsubscribe = subscription.unsubscribe;
    this.input.emit({
      type: "ui.order.list.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        records: subscription.records,
        deviceRevision: this.input.service.deviceRevision(this.lease()),
      },
    });
  }

  private async set(
    request: Extract<SessionInboundMessage, { type: "ui.order.set.request" }>,
  ): Promise<void> {
    try {
      const result = await this.input.service.set({
        ...request,
        principalId: this.input.principalId,
        device: this.lease(),
      });
      this.input.emit({
        type: "ui.order.set.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.input.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          code: "order_update_failed",
          error: error instanceof Error ? error.message : "Order update failed",
        },
      });
    }
  }
}
