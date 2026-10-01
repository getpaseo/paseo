import type { StreamItem, TimelinePosition } from "@/types/stream";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { TurnFooterHost } from "./layout";

export type AssistantTurnForkBoundary =
  | { boundaryCursor: TimelinePosition; boundaryMessageId?: string }
  | { boundaryCursor?: undefined; boundaryMessageId: string };

export type AssistantTurnForkHandler = (input: {
  target: AssistantForkTarget;
  boundary: AssistantTurnForkBoundary;
}) => Promise<void> | void;
export type InFlightTurnForkHandler = (target: AssistantForkTarget) => Promise<void> | void;

export function resolveTurnFooterForkHandler(input: {
  hasError: boolean;
  host: TurnFooterHost | null;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
  onForkInFlightTurn?: InFlightTurnForkHandler;
}): InFlightTurnForkHandler | undefined {
  if (input.onForkInFlightTurn) {
    return input.onForkInFlightTurn;
  }
  const onFork = input.onForkAssistantTurn;
  if (!input.hasError || !input.host || !onFork) {
    return undefined;
  }
  const boundary = resolveAssistantTurnForkBoundary({
    ...input.host,
    supportsTimelineCursor: input.supportsTimelineCursor,
  });
  return boundary ? (target) => onFork({ target, boundary }) : undefined;
}

export function resolveAssistantTurnForkBoundary(input: {
  items: readonly StreamItem[];
  startIndex: number;
  supportsTimelineCursor: boolean;
}): AssistantTurnForkBoundary | undefined {
  const item = input.items[input.startIndex];
  if (item?.kind !== "assistant_message") {
    return undefined;
  }
  if (input.supportsTimelineCursor && item.timelineCursor) {
    return {
      boundaryCursor: item.timelineCursor,
      ...(item.messageId ? { boundaryMessageId: item.messageId } : {}),
    };
  }
  return item.messageId ? { boundaryMessageId: item.messageId } : undefined;
}
