import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { KeeperControl } from "./keeper-control.js";

type Emit = (message: SessionOutboundMessage) => void;

export function dispatchKeeperMessage(
  control: KeeperControl | null,
  msg: SessionInboundMessage,
  emit: Emit,
): Promise<void> | undefined {
  switch (msg.type) {
    case "keeper.agent.get_snapshot.request":
      return (async () => {
        const enabled = control?.enabled === true;
        emit({
          type: "keeper.agent.get_snapshot.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            bootId: enabled ? control.bootId : "",
            snapshot: enabled ? control.snapshot(msg.agentId) : null,
            error: enabled ? null : "disabled",
          },
        });
      })();
    case "keeper.agent.send_message.request":
      return (async () => {
        const payload = control?.enabled
          ? await control.send(msg).catch((error: unknown) => ({
              requestId: msg.requestId,
              agentId: msg.agentId,
              idempotencyKey: msg.idempotencyKey,
              result: "rejected",
              reason: "send_failed",
              delivery: null,
              current: null,
              error: error instanceof Error ? error.message : String(error),
            }))
          : {
              requestId: msg.requestId,
              agentId: msg.agentId,
              idempotencyKey: msg.idempotencyKey,
              result: "rejected",
              reason: "disabled",
              delivery: null,
              current: null,
              error: null,
            };
        emit({ type: "keeper.agent.send_message.response", payload });
      })();
    case "keeper.agent.get_pending_request.request":
      return (async () => {
        const payload = control?.enabled
          ? control.pendingDetail(msg)
          : {
              requestId: msg.requestId,
              agentId: msg.agentId,
              reason: "disabled",
              detail: null,
              error: null,
            };
        emit({ type: "keeper.agent.get_pending_request.response", payload });
      })();
    case "keeper.events.read.request":
      return (async () => {
        const page = control?.enabled
          ? await control.readEvents(msg.cursor, msg.limit, msg.waitMs)
          : { events: [], nextCursor: "", headCursor: "", resyncRequired: false };
        emit({
          type: "keeper.events.read.response",
          payload: {
            requestId: msg.requestId,
            ...page,
            error: control?.enabled ? null : "disabled",
          },
        });
      })();
    default:
      return undefined;
  }
}
