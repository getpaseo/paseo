import { encodeHostRouteFrame, type HostRouteFrame } from "@getpaseo/protocol/binary-frames/index";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  DaemonPermission,
} from "@getpaseo/protocol/messages";
import { ConnectedHosts, HostError, type HostActor } from "./index.js";
import type { SessionDelivery } from "../session/owned-subscriptions/index.js";

type HostRequest<T extends SessionInboundMessage["type"]> = Extract<
  SessionInboundMessage,
  { type: T }
>;
interface SessionRoute {
  scopeId: string;
  source: object;
  send(data: string | Uint8Array): void;
  release(): Promise<void>;
  fail(code: string, message: string): void;
}

/** Adapts host capabilities to source-owned session delivery. */
export class ConnectedHostSession {
  private readonly routes = new Map<string, SessionRoute>();
  constructor(
    private readonly hosts: ConnectedHosts,
    private readonly delivery: SessionDelivery,
    private readonly actor: HostActor,
    private readonly permissions: () => DaemonPermission[],
    private readonly emit: (message: SessionOutboundMessage) => void,
    private readonly routed: () => boolean,
    private readonly originSessionId: string,
    private readonly bufferedAmount: (source: object) => number | null,
  ) {}
  binary(frame: HostRouteFrame, source: object): void {
    const route = this.routes.get(frame.routeId);
    if (!route || route.source !== source) return;
    try {
      route.send(frame.payload);
    } catch {
      route.fail("resource_limit", "Host input buffer limit reached");
    }
  }
  setSource(sourceId: string): void {
    this.actor.sourceId = sourceId;
  }
  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    if (!message.type.startsWith("hosts.")) return;
    return this.handle(message);
  }
  revoke(): void {
    for (const route of this.routes.values())
      route.fail(
        "permission_denied",
        "Caller authority changed. Reconnecting with current grants.",
      );
    void this.delivery.releaseFamily("host-route");
  }
  private async handle(message: SessionInboundMessage): Promise<void> {
    try {
      if (this.routed() && message.type.startsWith("hosts.route."))
        throw new HostError(
          "unsupported_capability",
          "Connected hosts support one hop. Connect to the managing daemon to select a host.",
        );
      await this.execute(message);
    } catch (error) {
      this.fail(message, error);
    }
  }
  private fail(message: SessionInboundMessage, error: unknown): void {
    let failure = new HostError(
      "host_error",
      "Host operation failed. Check the connection and retry.",
    );
    if (error instanceof HostError) failure = error;
    else if (error instanceof Error && "code" in error && error.code === "invalid_connection")
      failure = new HostError("invalid_connection", error.message);
    if (message.type === "hosts.route.frame.request") {
      const route = this.routes.get(message.routeId);
      if (route && route.source === this.delivery.currentSource)
        route.fail(failure.code, failure.message);
      return;
    }
    if (!("requestId" in message) || !message.requestId) return;
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: message.requestId,
        requestType: message.type,
        code: failure.code,
        error: failure.message,
      },
    });
  }
  private async execute(message: SessionInboundMessage): Promise<void> {
    const actor = { ...this.actor, manageSources: this.permissions().includes("access.manage") };
    switch (message.type) {
      case "hosts.list.request":
        return this.list(message);
      case "hosts.add.request":
        this.emit({
          type: "hosts.add.response",
          payload: {
            requestId: message.requestId,
            host: await this.hosts.add(message.input, actor),
          },
        });
        return;
      case "hosts.update.request":
        this.emit({
          type: "hosts.update.response",
          payload: {
            requestId: message.requestId,
            host: await this.hosts.update(message.registrationId, message.patch, actor),
          },
        });
        return;
      case "hosts.remove.request":
        await this.hosts.remove(message.registrationId, actor);
        this.emit({ type: "hosts.remove.response", payload: { requestId: message.requestId } });
        return;
      case "hosts.route.open.request":
        return this.open(message);
      case "hosts.route.frame.request": {
        const route = this.routes.get(message.routeId);
        if (!route || route.source !== this.delivery.currentSource)
          throw new HostError("host_unknown", "Unknown routed session");
        route.send(message.data);
        return;
      }
      case "hosts.route.close.request": {
        const route = message.routeId
          ? this.routes.get(message.routeId)
          : [...this.routes.values()].find(
              (entry) =>
                entry.scopeId === message.scopeId && entry.source === this.delivery.currentSource,
            );
        if (route && route.source === this.delivery.currentSource) await route.release();
        return;
      }
    }
  }
  private async list(message: HostRequest<"hosts.list.request">): Promise<void> {
    if (!message.observe) {
      this.emit({
        type: "hosts.list.response",
        payload: { requestId: message.requestId, directory: await this.hosts.list() },
      });
      return;
    }
    let stop = () => {};
    const owner = this.delivery.begin("hosts", undefined, () => stop());
    try {
      stop = this.hosts.observe(() => {
        void this.hosts
          .list()
          .then((directory) => {
            owner.emit({ type: "hosts.changed", payload: { subscriptionId: owner.id, directory } });
            return undefined;
          })
          .catch(() => owner.release());
      });
      this.emit({
        type: "hosts.list.response",
        payload: {
          requestId: message.requestId,
          subscriptionId: owner.id,
          directory: await this.hosts.list(),
        },
      });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
  private async open(message: HostRequest<"hosts.route.open.request">): Promise<void> {
    if (this.delivery.subscriptionIds(this.delivery.currentSource!, "host-route").length >= 32)
      throw new HostError("resource_limit", "Too many routed sessions for this caller");
    let close = () => {};
    const owner = this.delivery.begin("host-route", undefined, () => {
      this.routes.delete(owner.id);
      close();
    });
    const fail = (code: string, text: string) => {
      owner.emit({
        type: "hosts.route.closed",
        payload: { subscriptionId: owner.id, code, message: text },
      });
      void owner.release();
    };
    this.routes.set(owner.id, {
      scopeId: message.scopeId,
      source: owner.source,
      send: () => {
        throw new HostError("host_offline", "Host is connecting");
      },
      release: owner.release,
      fail,
    });
    try {
      const route = await this.hosts.openRoute({
        serverId: message.serverId,
        scopeId: message.scopeId,
        sourceId: this.actor.sourceId,
        originSessionId: this.originSessionId,
        permissions: this.permissions(),
        signal: owner.signal,
        frame: (data) => {
          const output: SessionOutboundMessage | null =
            typeof data === "string"
              ? {
                  type: "hosts.route.frame",
                  payload: { subscriptionId: owner.id, data, binary: false },
                }
              : null;
          const binary = typeof data === "string" ? null : encodeHostRouteFrame(owner.id, data);
          const size = output
            ? Buffer.byteLength(JSON.stringify({ type: "session", message: output }))
            : binary!.byteLength;
          const buffered = this.bufferedAmount(owner.source);
          if (buffered === null || buffered + size > 32 * 1024 * 1024) {
            fail("resource_limit", "The receiving client cannot keep up with host output");
            return;
          }
          if (output) owner.emit(output);
          else owner.emitBinary(binary!);
        },
        ended: fail,
      });
      close = route.close;
      if (owner.signal.aborted) {
        route.close();
        return;
      }
      this.routes.set(owner.id, {
        scopeId: message.scopeId,
        source: owner.source,
        send: route.send,
        release: owner.release,
        fail,
      });
      this.emit({
        type: "hosts.route.open.response",
        payload: { requestId: message.requestId, routeId: owner.id },
      });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
}
