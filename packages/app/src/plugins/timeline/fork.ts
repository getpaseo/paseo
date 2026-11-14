import type { PluginTimelineStreamItem } from "@/types/stream";
import { resolveAssistantMessageForkBoundary } from "@/agent-stream/turn-boundary";
import type { AssistantTurnForkHandler } from "@/agent-stream/turn-footer";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";

export function resolvePluginTimelineFork(input: {
  item: PluginTimelineStreamItem;
  supportsTimelineCursor: boolean;
  onForkAssistantTurn?: AssistantTurnForkHandler;
}): ((target: AssistantForkTarget) => Promise<void> | void) | null {
  const { item, onForkAssistantTurn } = input;
  if (!item.sourceAssistant || !onForkAssistantTurn) return null;
  const boundary = resolveAssistantMessageForkBoundary({
    item: { ...item.sourceAssistant, timelineCursor: item.timelineCursor },
    supportsTimelineCursor: input.supportsTimelineCursor,
  });
  if (!boundary) return null;
  return (target) => onForkAssistantTurn({ target, boundary });
}
