import type { StreamItem } from "@/types/stream";

type AssistantMessageItem = Extract<StreamItem, { kind: "assistant_message" }>;

export interface TerminalAssistantGroup {
  readonly anchorItemId: string;
  readonly items: readonly AssistantMessageItem[];
  readonly itemIds: ReadonlySet<string>;
}

/** Finds the final assistant message, including every streamed block that belongs to it. */
export function findTerminalAssistantGroup(
  response: readonly StreamItem[],
): TerminalAssistantGroup | null {
  let assistantIndex: number | null = null;
  let lastWorkIndex = -1;

  for (let index = 0; index < response.length; index += 1) {
    const item = response[index];
    if (!item) continue;
    if (item.kind === "assistant_message") {
      assistantIndex = index;
    } else if (item.kind === "thought" || item.kind === "tool_call" || item.kind === "todo_list") {
      lastWorkIndex = index;
    }
  }

  if (assistantIndex === null || assistantIndex < lastWorkIndex) {
    return null;
  }

  const terminalAssistant = response[assistantIndex];
  if (!terminalAssistant || terminalAssistant.kind !== "assistant_message") {
    return null;
  }

  const terminalBlockGroupId = terminalAssistant.blockGroupId;
  if (!terminalBlockGroupId) {
    return {
      anchorItemId: terminalAssistant.id,
      items: [terminalAssistant],
      itemIds: new Set([terminalAssistant.id]),
    };
  }

  const items = response.filter(
    (item, index): item is AssistantMessageItem =>
      index > lastWorkIndex &&
      item.kind === "assistant_message" &&
      item.blockGroupId === terminalBlockGroupId,
  );
  const anchor = items[0];
  if (!anchor) {
    return null;
  }
  return {
    anchorItemId: anchor.id,
    items,
    itemIds: new Set(items.map((item) => item.id)),
  };
}
