import type { Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

function parseSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    return envelope.type === "session" && envelope.message && typeof envelope.message === "object"
      ? (envelope.message as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getToolCallStatus(
  message: WebSocketMessage,
  agentId: string,
): { callId: string; status: string } | null {
  const sessionMessage = parseSessionMessage(message);
  if (sessionMessage?.type !== "agent_stream") {
    return null;
  }
  const payload = sessionMessage.payload as Record<string, unknown> | undefined;
  if (payload?.agentId !== agentId) {
    return null;
  }
  const event = payload.event as Record<string, unknown> | undefined;
  const item = event?.item as Record<string, unknown> | undefined;
  return event?.type === "timeline" &&
    item?.type === "tool_call" &&
    typeof item.callId === "string" &&
    typeof item.status === "string"
    ? { callId: item.callId, status: item.status }
    : null;
}

function replaceToolCallStatus(message: WebSocketMessage, status: string): string {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  const envelope = JSON.parse(raw) as {
    message?: { payload?: { event?: { item?: { status?: string } } } };
  };
  const item = envelope.message?.payload?.event?.item;
  if (!item) {
    throw new Error("Expected a tool-call session message");
  }
  item.status = status;
  return JSON.stringify(envelope);
}

export async function gateSecondToolCall(page: Page, agentId: string) {
  let firstCallId: string | null = null;
  let secondCallId: string | null = null;
  let secondRunningMessage: WebSocketMessage | null = null;
  let pauseAfterSecondRunning = false;
  let releaseSecondRequested = false;
  let forwardSecondRunning: (() => void) | null = null;
  let resolveFirstCompleted!: () => void;
  let resolveSecondRunning!: () => void;
  const firstCompleted = new Promise<void>((resolve) => {
    resolveFirstCompleted = resolve;
  });
  const secondRunning = new Promise<void>((resolve) => {
    resolveSecondRunning = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    forwardSecondRunning = () => {
      if (secondRunningMessage) {
        ws.send(secondRunningMessage);
        secondRunningMessage = null;
      }
    };
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (pauseAfterSecondRunning) {
        return;
      }

      const toolCall = getToolCallStatus(message, agentId);
      if (!toolCall) {
        ws.send(message);
        return;
      }

      if (!firstCallId) {
        firstCallId = toolCall.callId;
      }
      if (toolCall.callId === firstCallId) {
        ws.send(message);
        if (toolCall.status === "completed") {
          resolveFirstCompleted();
        }
        return;
      }

      secondCallId ??= toolCall.callId;
      if (toolCall.callId === secondCallId) {
        const transformedMessage =
          toolCall.status === "completed" ? replaceToolCallStatus(message, "running") : message;
        secondRunningMessage = transformedMessage;
        pauseAfterSecondRunning = true;
        resolveSecondRunning();
        if (releaseSecondRequested) {
          forwardSecondRunning?.();
        }
        return;
      }

      ws.send(message);
    });
  });

  return {
    waitForFirstCompleted: () => firstCompleted,
    waitForSecondRunning: () => secondRunning,
    releaseSecondRunning() {
      releaseSecondRequested = true;
      forwardSecondRunning?.();
    },
  };
}
