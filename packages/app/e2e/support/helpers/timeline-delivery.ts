import { expect, type Page } from "@playwright/test";

type WebSocketMessage = string | Buffer;

interface SessionMessage {
  type?: unknown;
  payload?: unknown;
}

interface TimelineSubscriptionWaitOptions {
  timeout?: number;
}

function readSessionMessage(message: WebSocketMessage): SessionMessage | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as {
      type?: unknown;
      message?: SessionMessage;
    };
    return envelope.type === "session" ? (envelope.message ?? null) : envelope;
  } catch {
    return null;
  }
}

export function observeTimelineSubscriptions(page: Page) {
  let acknowledgedAgentIds: string[] | null = null;

  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const message = readSessionMessage(payload);
      if (message?.type !== "agent.timeline.set_subscription.response") return;
      const response = message.payload as { agentIds?: unknown } | undefined;
      if (!Array.isArray(response?.agentIds)) return;
      acknowledgedAgentIds = response.agentIds.filter(
        (agentId): agentId is string => typeof agentId === "string",
      );
    });
  });

  return {
    async waitForSubscribedAgents(
      agentIds: string[],
      options: TimelineSubscriptionWaitOptions = {},
    ): Promise<void> {
      const expected = [...new Set(agentIds)].sort();
      await expect
        .poll(() => acknowledgedAgentIds?.slice().sort() ?? null, {
          timeout: options.timeout ?? 15_000,
        })
        .toEqual(expected);
    },
  };
}
