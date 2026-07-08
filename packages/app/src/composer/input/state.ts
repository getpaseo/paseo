import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MessagePayload } from "@/composer/types";

export type SendBehavior = "interrupt" | "queue";

interface SendActionContext {
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  handleSendMessage: () => void;
  handleQueueMessage: () => void;
}

export function computeCanStartDictation(input: {
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  disabled: boolean;
  dictationUnavailableMessage: string | null | undefined;
}): boolean {
  const socketConnected = input.client?.isConnected ?? false;
  const readyForDictation = input.isReadyForDictation ?? socketConnected;
  return (
    socketConnected && readyForDictation && !input.disabled && !input.dictationUnavailableMessage
  );
}

export function runDefaultSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
    return;
  }
  ctx.handleSendMessage();
}

export function runAlternateSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue") {
    ctx.handleSendMessage();
    return;
  }
  if (ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
  }
}

interface LongPressQueueContext {
  onQueue: ((payload: MessagePayload) => void) | undefined;
  /** Queues the current draft. Returns true when something was actually queued. */
  queueMessage: () => boolean;
  /** Side effect (e.g. haptic feedback) fired only when a message was queued. */
  onQueued: () => void;
}

/**
 * Long-pressing the send button queues the message instead of sending it,
 * independent of the configured default send behavior. This reuses the same
 * queue path as Mod+Enter / the "queue" send setting, but exposes it as a touch
 * gesture so mobile users can queue without changing a setting. No-ops when
 * queueing is unavailable (`onQueue` missing) or there is nothing to queue.
 */
export function runLongPressQueueAction(ctx: LongPressQueueContext): void {
  if (!ctx.onQueue) return;
  if (ctx.queueMessage()) {
    ctx.onQueued();
  }
}
