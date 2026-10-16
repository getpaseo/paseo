import type { TimelineItemTransform } from "@/plugins/timeline/model";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";
import type { StreamItem, UserMessageItem } from "@/types/stream";

interface PresentationInput {
  tail: StreamItem[];
  head: StreamItem[];
  transform: TimelineItemTransform | undefined;
  level: ToolCallDetailLevel;
  isTurnActive: boolean;
}

/** Find and scrolling address a plugin row by the source it replaces. */
export function getStreamItemMessageId(item: StreamItem): string {
  if (item.kind === "plugin") return item.sourceId ?? item.id;
  return item.id;
}

/** Source messages reach plugins before display projection. */
export function createStreamPresentation() {
  const userMessageCache = new WeakMap<UserMessageItem, UserMessageItem>();

  function presentUserMessage(item: UserMessageItem): UserMessageItem {
    const cached = userMessageCache.get(item);
    if (cached) return cached;

    // Recognize the complete voice envelope, including older messages without the
    // instruction suffix. Leave quoted examples and unrelated XML untouched.
    const spokenInput =
      /^\s*<spoken-input>([\s\S]*?)<\/spoken-input>(?:\s*<instruction>This message was spoken by the user\.[\s\S]*?<\/instruction>)?\s*$/.exec(
        item.text,
      );
    const projected = spokenInput ? { ...item, text: spokenInput[1].trim() } : item;
    userMessageCache.set(item, projected);
    return projected;
  }

  let historySource: StreamItem[] | undefined;
  let historyTransform: TimelineItemTransform | undefined;
  let historyRows: StreamItem[] = [];
  let preparedTail: StreamItem[] | undefined;
  let preparedLevel: ToolCallDetailLevel | undefined;
  let preparedHistory: PreparedToolCallHistory | null = null;

  function presentRows(item: StreamItem): StreamItem[] {
    return [item.kind === "user_message" ? presentUserMessage(item) : item];
  }

  return (input: PresentationInput) => {
    // Retained history is not reprojected or regrouped on each live text update.
    if (historySource !== input.tail || historyTransform !== input.transform) {
      historyRows = projectPluginTimelineItems(input.tail, input.transform).flatMap<StreamItem>(
        (item) => presentRows(item),
      );
      historySource = input.tail;
      historyTransform = input.transform;
    }
    const head: StreamItem[] = [];
    for (const item of projectPluginTimelineItems(input.head, input.transform, "streaming")) {
      const blocks = presentRows(item);
      head.push(...blocks);
    }
    if (preparedTail !== historyRows || preparedLevel !== input.level) {
      preparedHistory = prepareToolCallHistory(input.level, historyRows);
      preparedTail = historyRows;
      preparedLevel = input.level;
    }
    return projectToolCallDetailLevel({
      level: input.level,
      tail: historyRows,
      head,
      preparedHistory,
      isTurnActive: input.isTurnActive,
    });
  };
}
