import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { TunnelError, type TunnelManager } from "./manager.js";

type TunnelRequest<T extends SessionInboundMessage["type"]> = Extract<
  SessionInboundMessage,
  { type: T }
>;

/** Adapts daemon TunnelManager capabilities to source-owned session delivery. */
export class TunnelSession {
  constructor(
    private readonly tunnels: Pick<
      TunnelManager,
      "listProviders" | "listExposures" | "expose" | "close" | "subscribe"
    >,
    private readonly delivery: SessionDelivery,
    private readonly emit: (message: SessionOutboundMessage) => void,
  ) {}

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!message.type.startsWith("tunnel.")) return;
    return this.handle(message);
  }

  private async handle(message: SessionInboundMessage): Promise<void> {
    try {
      await this.execute(message);
    } catch (error) {
      this.fail(message, error);
    }
  }

  private fail(message: SessionInboundMessage, error: unknown): void {
    if (!("requestId" in message) || !message.requestId) return;
    const code = error instanceof TunnelError ? error.code : "tunnel_error";
    const text = error instanceof Error ? error.message : String(error);
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: message.requestId,
        requestType: message.type,
        code,
        error: text,
      },
    });
  }

  private async execute(message: SessionInboundMessage): Promise<void> {
    switch (message.type) {
      case "tunnel.providers.list.request":
        this.emit({
          type: "tunnel.providers.list.response",
          payload: {
            requestId: message.requestId,
            providers: await this.tunnels.listProviders({ signal: this.delivery.requestSignal }),
          },
        });
        return;
      case "tunnel.exposures.list.request":
        return this.listExposures(message);
      case "tunnel.exposure.open.request": {
        const exposure = await this.tunnels.expose({
          id: message.id,
          providerId: message.providerId,
          host: message.host,
          port: message.port,
          label: message.label,
          slug: message.slug,
          signal: this.delivery.requestSignal,
        });
        this.emit({
          type: "tunnel.exposure.open.response",
          payload: { requestId: message.requestId, exposure },
        });
        return;
      }
      case "tunnel.exposure.close.request": {
        const closed = await this.tunnels.close(message.exposureId);
        this.emit({
          type: "tunnel.exposure.close.response",
          payload: {
            requestId: message.requestId,
            exposureId: message.exposureId,
            closed,
          },
        });
        return;
      }
    }
  }

  private async listExposures(
    message: TunnelRequest<"tunnel.exposures.list.request">,
  ): Promise<void> {
    if (!message.observe) {
      this.emit({
        type: "tunnel.exposures.list.response",
        payload: {
          requestId: message.requestId,
          exposures: this.tunnels.listExposures(),
        },
      });
      return;
    }
    let stop = () => {};
    const owner = this.delivery.begin("tunnels", undefined, () => stop());
    try {
      stop = this.tunnels.subscribe((event) => {
        if (event.type !== "exposure.changed") return;
        owner.emit({
          type: "tunnel.exposure.changed",
          payload: { subscriptionId: owner.id, exposure: event.exposure },
        });
      });
      this.emit({
        type: "tunnel.exposures.list.response",
        payload: {
          requestId: message.requestId,
          subscriptionId: owner.id,
          exposures: this.tunnels.listExposures(),
        },
      });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
}
