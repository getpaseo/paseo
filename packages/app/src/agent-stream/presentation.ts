import type { AssistantMessageItem, StreamItem, UserMessageItem } from "@/types/stream";
import type { TimelineItemTransform } from "@/plugins/timeline/model";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import { splitMarkdownBlocks } from "@/utils/split-markdown-blocks";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";

interface PresentationInput {
  tail: StreamItem[];
  head: StreamItem[];
  transform: TimelineItemTransform | undefined;
  level: ToolCallDetailLevel;
  isTurnActive: boolean;
}

function retainItems(previous: StreamItem[], next: StreamItem[]): StreamItem[] {
  return previous.length === next.length && previous.every((item, index) => item === next[index])
    ? previous
    : next;
}

/** Source messages reach plugins before any Markdown splitting or Overview grouping. */
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

  const blocksBySource = new WeakMap<AssistantMessageItem, AssistantMessageItem[]>();
  let liveSources = new Map<string, AssistantMessageItem>();
  let historySource: StreamItem[] | undefined;
  let historyTransform: TimelineItemTransform | undefined;
  let historyRows: StreamItem[] = [];
  let displayTail: StreamItem[] = [];
  let displayHistory: StreamItem[] | undefined;
  let promotedRows: StreamItem[] = [];
  let preparedTail: StreamItem[] | undefined;
  let preparedLevel: ToolCallDetailLevel | undefined;
  let preparedHistory: PreparedToolCallHistory | null = null;

  function nativeBlocks(item: StreamItem): StreamItem[] {
    if (item.kind === "user_message") return [presentUserMessage(item)];
    if (item.kind !== "assistant_message") return [item];
    const cached = blocksBySource.get(item);
    if (cached) return cached;
    const previousSource = liveSources.get(item.id);
    const previous = previousSource && blocksBySource.get(previousSource);
    // Parse only the growing last block on append, as the old live reducer did.
    // Canonical text replacements are parsed afresh instead of joining fragments.
    const isAppend = previousSource && previous && item.text.startsWith(previousSource.text);
    let prefix: AssistantMessageItem[] = [];
    let growingText = item.text;
    if (isAppend) {
      prefix = previous.slice(0, -1);
      growingText =
        previous[previous.length - 1]!.text + item.text.slice(previousSource.text.length);
    }
    const textBlocks = splitMarkdownBlocks(growingText);
    if (prefix.length + textBlocks.length < 2) {
      blocksBySource.set(item, [item]);
      return [item];
    }

    const blocks = [...prefix];
    for (const [offset, text] of textBlocks.entries()) {
      const index = prefix.length + offset;
      let blockText = text;
      if (offset === textBlocks.length - 1) {
        const trailingNewlines = /\n+$/.exec(item.text)?.[0] ?? "";
        blockText += trailingNewlines;
      }
      const existing = previous?.[index];
      const id = `${item.id}:block:${index}`;
      // Completed display blocks keep their first cursor and object identity while
      // the source message grows. The source itself always retains the latest cursor.
      if (existing?.id === id && existing.text === blockText && existing.turnId === item.turnId) {
        blocks.push(existing);
        continue;
      }
      blocks.push({
        ...item,
        id,
        blockGroupId: item.id,
        blockIndex: index,
        text: blockText,
      });
    }
    blocksBySource.set(item, blocks);
    return blocks;
  }

  return (input: PresentationInput) => {
    // Retained history is not reprojected or regrouped on each live text update.
    if (historySource !== input.tail || historyTransform !== input.transform) {
      historyRows = projectPluginTimelineItems(input.tail, input.transform).flatMap<StreamItem>(
        (item) => {
          // Preserve live block identities at completion; fetched native Markdown
          // stays whole so links and other cross-block constructs keep their context.
          if (item.kind === "assistant_message") return blocksBySource.get(item) ?? [item];
          return [item.kind === "user_message" ? presentUserMessage(item) : item];
        },
      );
      historySource = input.tail;
      historyTransform = input.transform;
    }
    const head: StreamItem[] = [];
    const promoted: StreamItem[] = [];
    const nextLiveSources = new Map<string, AssistantMessageItem>();
    for (const item of projectPluginTimelineItems(input.head, input.transform, "streaming")) {
      const blocks = nativeBlocks(item);
      if (item.kind === "assistant_message") nextLiveSources.set(item.id, item);
      if (item.kind === "assistant_message" && blocks.length > 1) {
        promoted.push(...blocks.slice(0, -1));
        head.push(blocks[blocks.length - 1]!);
      } else {
        head.push(...blocks);
      }
    }
    liveSources = nextLiveSources;
    const nextPromoted = retainItems(promotedRows, promoted);
    if (displayHistory !== historyRows || nextPromoted !== promotedRows) {
      displayTail = historyRows;
      if (nextPromoted.length > 0) displayTail = [...historyRows, ...nextPromoted];
      displayHistory = historyRows;
      promotedRows = nextPromoted;
    }
    if (preparedTail !== displayTail || preparedLevel !== input.level) {
      preparedHistory = prepareToolCallHistory(input.level, displayTail);
      preparedTail = displayTail;
      preparedLevel = input.level;
    }
    return projectToolCallDetailLevel({
      level: input.level,
      tail: displayTail,
      head,
      preparedHistory,
      isTurnActive: input.isTurnActive,
    });
  };
}
