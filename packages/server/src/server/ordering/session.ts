import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";
import type { OrderingService } from "./index.js";

export function createOrderingSession(
  service: OrderingService | undefined,
  delivery: SessionDelivery,
  emit: (message: SessionOutboundMessage) => void,
): OrderingSession | null {
  return service ? new OrderingSession(service, delivery, emit) : null;
}

export class OrderingSession {
  constructor(
    private readonly service: OrderingService,
    private readonly delivery: SessionDelivery,
    private readonly emit: (message: SessionOutboundMessage) => void,
  ) {}

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "ui.order.list.request":
        return this.list(message);
      case "ui.order.set.request":
        return this.set(message);
      default:
        return undefined;
    }
  }

  private async list(
    request: Extract<SessionInboundMessage, { type: "ui.order.list.request" }>,
  ): Promise<void> {
    if (!request.subscribe) {
      this.emit({
        type: "ui.order.list.response",
        payload: { requestId: request.requestId, records: this.service.list() },
      });
      return;
    }
    let unsubscribe: (() => void) | undefined;
    const owner = this.delivery.begin("ui-order", request.subscribe.subscriptionId, () =>
      unsubscribe?.(),
    );
    const subscription = this.service.subscribe((change) => {
      owner.emit({ type: "ui.order.update", payload: change });
    });
    unsubscribe = subscription.unsubscribe;
    this.emit({
      type: "ui.order.list.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        records: subscription.records,
      },
    });
  }

  private async set(
    request: Extract<SessionInboundMessage, { type: "ui.order.set.request" }>,
  ): Promise<void> {
    try {
      const result = await this.service.set(request);
      this.emit({
        type: "ui.order.set.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.emit({
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
