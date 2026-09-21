import type { StreamItem } from "@/types/stream";
import { isSameAssistantBlockGroup } from "./spacing";

export type AssistantBlockRender = { kind: "skip" } | { kind: "text"; text: string };

export function resolveAssistantBlockRender(input: {
  item: StreamItem;
  aboveItem: StreamItem | null;
  belowItem: StreamItem | null;
  phase: "streaming" | "complete";
  getAboveItem: (id: string) => StreamItem | null | undefined;
}): AssistantBlockRender {
  if (input.item.kind !== "assistant_message") {
    return { kind: "skip" };
  }
  if (input.phase === "streaming" || input.item.blockGroupId === undefined) {
    return { kind: "text", text: input.item.text };
  }
  if (isSameAssistantBlockGroup({ item: input.item, other: input.belowItem })) {
    return { kind: "skip" };
  }

  const texts: string[] = [input.item.text];
  let older: StreamItem | null | undefined = input.aboveItem;
  while (older && isSameAssistantBlockGroup({ item: input.item, other: older })) {
    if (older.kind === "assistant_message") {
      texts.push(older.text);
    }
    older = input.getAboveItem(older.id);
  }
  return { kind: "text", text: texts.toReversed().join("\n\n") };
}
