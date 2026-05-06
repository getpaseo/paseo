import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

export async function* streamSession(
  session: Pick<AgentSession, "startTurn" | "subscribe">,
  prompt: AgentPromptInput,
  options?: AgentRunOptions,
): AsyncGenerator<AgentStreamEvent> {
  const queue: AgentStreamEvent[] = [];
  const waiters: Array<() => void> = [];
  let turnId: string | null = null;
  let closed = false;

  const wake = () => {
    const waiter = waiters.shift();
    waiter?.();
  };

  const matchesTurn = (event: AgentStreamEvent): boolean => {
    const eventTurnId = (event as { turnId?: string }).turnId;
    return turnId == null || eventTurnId == null || eventTurnId === turnId;
  };

  const unsubscribe = session.subscribe((event) => {
    if (!matchesTurn(event)) {
      return;
    }
    queue.push(event);
    wake();
  });

  try {
    const result = await session.startTurn(prompt, options);
    turnId = result.turnId;

    for (let idx = queue.length - 1; idx >= 0; idx -= 1) {
      if (!matchesTurn(queue[idx])) {
        queue.splice(idx, 1);
      }
    }

    for (;;) {
      if (closed) break;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
        continue;
      }

      const event = queue.shift()!;
      yield event;
      if (isTerminalEvent(event)) {
        return;
      }
    }
  } finally {
    closed = true;
    unsubscribe();
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.();
    }
  }
}
