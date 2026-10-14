import { isInteractiveResponseToolName } from "@getpaseo/protocol/tool-name-normalization";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
import type { StreamItem } from "@/types/stream";

export interface ResponseFoldHeader {
  responseId: string;
  count: number;
  expanded: boolean;
}

export interface ResponseFolding {
  headersByHostId: Map<string, ResponseFoldHeader>;
  hiddenItemIds: Set<string>;
  hiddenMessageResponseIds: Map<string, string>;
}

function countMessages(steps: StreamItem[], toolCallCount?: (item: StreamItem) => number): number {
  const messageIds = new Set<string>();
  let count = 0;
  for (const item of steps) {
    const id = item.kind === "assistant_message" ? (item.blockGroupId ?? item.id) : item.id;
    if (messageIds.has(id)) continue;
    messageIds.add(id);
    count += item.kind === "tool_call" ? (toolCallCount?.(item) ?? 1) : 1;
  }
  return count;
}

export function projectResponseFolding(input: {
  /** Chronological, already projected rows in the mounted history window. */
  items: readonly StreamItem[];
  isTurnActive: boolean;
  activeTurnId: string | null;
  expandedResponseIds: ReadonlySet<string>;
  toolCallCount?: (item: StreamItem) => number;
  previous?: ResponseFolding;
}): ResponseFolding {
  const headersByHostId = new Map<string, ResponseFoldHeader>();
  const hiddenItemIds = new Set<string>();
  const hiddenMessageResponseIds = new Map<string, string>();
  let start = 0;

  const foldResponse = (end: number) => {
    const response = input.items.slice(start, end);
    if (response.length < 2) return;
    if (
      input.isTurnActive &&
      (end === input.items.length ||
        (input.activeTurnId !== null &&
          response.some((item) => item.turnId === input.activeTurnId)))
    )
      return;

    const final = response.at(-1);
    if (final?.kind !== "assistant_message") return;
    const responseId = final.blockGroupId ?? final.id;
    let finalStart = response.length - 1;
    while (finalStart > 0) {
      const previous = response[finalStart - 1];
      if (
        previous.kind !== "assistant_message" ||
        (previous.blockGroupId ?? previous.id) !== responseId
      )
        break;
      finalStart--;
    }
    const steps = response
      .slice(0, finalStart)
      .filter(
        (item) =>
          item.kind !== "notification" &&
          item.kind !== "compaction" &&
          !(
            item.kind === "tool_call" && isInteractiveResponseToolName(describeToolCall(item).name)
          ),
      );
    const host = steps[0];
    if (!host) return;
    const expanded = input.expandedResponseIds.has(responseId);
    const count = countMessages(steps, input.toolCallCount);
    headersByHostId.set(host.id, { responseId, count, expanded });
    if (!expanded) {
      for (const item of steps) {
        const messageId =
          item.kind === "assistant_message" ? (item.blockGroupId ?? item.id) : item.id;
        hiddenMessageResponseIds.set(messageId, responseId);
      }
      for (const item of steps.slice(1)) hiddenItemIds.add(item.id);
    }
  };

  for (let index = 0; index < input.items.length; index++) {
    if (input.items[index].kind === "user_message") {
      foldResponse(index);
      start = index + 1;
    }
  }
  foldResponse(input.items.length);
  // Streaming text changes must not invalidate every folded history row.
  const previous = input.previous;
  if (
    previous &&
    previous.headersByHostId.size === headersByHostId.size &&
    previous.hiddenItemIds.size === hiddenItemIds.size &&
    previous.hiddenMessageResponseIds.size === hiddenMessageResponseIds.size &&
    [...hiddenMessageResponseIds].every(
      ([id, responseId]) => previous.hiddenMessageResponseIds.get(id) === responseId,
    ) &&
    [...hiddenItemIds].every((id) => previous.hiddenItemIds.has(id)) &&
    [...headersByHostId].every(([id, header]) => {
      const old = previous.headersByHostId.get(id);
      return (
        old?.responseId === header.responseId &&
        old.count === header.count &&
        old.expanded === header.expanded
      );
    })
  )
    return previous;
  return { headersByHostId, hiddenItemIds, hiddenMessageResponseIds };
}
