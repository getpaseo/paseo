import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

export type ProviderFinalTextReducer = (params: {
  current: string;
  item: AgentTimelineItem;
}) => string;

export interface ProviderTurnRunner {
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  getSessionId(): string | Promise<string>;
}

export interface RunProviderTurnOptions extends ProviderTurnRunner {
  prompt: AgentPromptInput;
  runOptions?: AgentRunOptions;
  reduceFinalText?: ProviderFinalTextReducer;
}

export async function runProviderTurn({
  prompt,
  runOptions,
  startTurn,
  subscribe,
  getSessionId,
  reduceFinalText = replaceFinalTextWithAssistantMessage,
}: RunProviderTurnOptions): Promise<AgentRunResult> {
  const timeline: AgentTimelineItem[] = [];
  let finalText = "";
  let usage: AgentRunResult["usage"];
  let turnId: string | null = null;
  const bufferedEvents: AgentStreamEvent[] = [];
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;

  const processEvent = (event: AgentStreamEvent) => {
    if (settled) {
      return;
    }
    const eventTurnId = "turnId" in event ? event.turnId : undefined;
    if (turnId && eventTurnId && eventTurnId !== turnId) {
      return;
    }
    if (event.type === "timeline") {
      timeline.push(event.item);
      finalText = reduceFinalText({ current: finalText, item: event.item });
      return;
    }
    if (event.type === "turn_completed") {
      usage = event.usage;
      settled = true;
      resolveCompletion();
      return;
    }
    if (event.type === "turn_failed") {
      settled = true;
      rejectCompletion(new Error(event.error));
      return;
    }
    if (event.type === "turn_canceled") {
      settled = true;
      resolveCompletion();
    }
  };

  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const unsubscribe = subscribe((event) => {
    if (!turnId) {
      bufferedEvents.push(event);
      return;
    }
    processEvent(event);
  });

  try {
    const result = await startTurn(prompt, runOptions);
    turnId = result.turnId;
    for (const event of bufferedEvents) {
      processEvent(event);
    }
    await completion;
  } finally {
    unsubscribe();
  }

  return {
    sessionId: await getSessionId(),
    finalText,
    usage,
    timeline,
  };
}

export function replaceFinalTextWithAssistantMessage({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  return item.type === "assistant_message" ? item.text : current;
}

export function appendOrReplaceGrowingAssistantMessage({
  current,
  item,
}: {
  current: string;
  item: AgentTimelineItem;
}): string {
  if (item.type !== "assistant_message") {
    return current;
  }
  if (!current) {
    return item.text;
  }
  return item.text.startsWith(current) ? item.text : `${current}${item.text}`;
}
