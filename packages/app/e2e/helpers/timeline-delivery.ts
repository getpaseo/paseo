import { expect, type Page } from "@playwright/test";

type WebSocketMessage = string | Buffer;

interface SessionMessage {
  type?: unknown;
  payload?: unknown;
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
    async waitForSubscribedAgents(agentIds: string[]): Promise<void> {
      const expected = [...new Set(agentIds)].sort();
      await expect
        .poll(() => acknowledgedAgentIds?.slice().sort() ?? null, { timeout: 15_000 })
        .toEqual(expected);
    },
  };
}

interface AssistantFrameState {
  active: boolean;
  lastText: string | null;
  snapshots: string[];
}

export async function observeLastAssistantFrames(page: Page) {
  await page.evaluate(() => {
    const state: AssistantFrameState = {
      active: true,
      lastText: null,
      snapshots: [],
    };
    const sample = () => {
      const hasPaintedHistoryOverlay = Array.from(
        document.querySelectorAll('[data-testid="agent-history-overlay"]'),
      ).some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!hasPaintedHistoryOverlay) {
        const messages = Array.from(
          document.querySelectorAll('[data-testid="assistant-message"]'),
        ).filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const text = messages.at(-1)?.textContent?.trim() ?? "";
        if (text && text !== state.lastText) {
          state.lastText = text;
          state.snapshots.push(text);
        }
      }
      if (state.active) requestAnimationFrame(sample);
    };
    Object.assign(window, { __assistantFrameState: state });
    requestAnimationFrame(sample);
  });

  return {
    async stop(): Promise<string[]> {
      return page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            requestAnimationFrame(() => {
              const state = (
                window as typeof window & { __assistantFrameState?: AssistantFrameState }
              ).__assistantFrameState;
              if (!state) {
                resolve([]);
                return;
              }
              state.active = false;
              resolve([...state.snapshots]);
            });
          }),
      );
    },
  };
}
