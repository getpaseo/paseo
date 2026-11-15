import { isTurnBoundary } from "@/agent-stream/turn-membership";
import type { StreamItem } from "@/types/stream";
import { describeToolCall, isGroupableToolCall, type GroupableItem } from "./grouping";
import { collectToolCallImages, type ToolCallImage } from "./overview/model";

interface ToolImageRun {
  last: GroupableItem | null;
  toolName: string | null;
  images: readonly ToolCallImage[];
}

/** Full keeps raw rows: index only their images, without hosts, tool summaries or loading state. */
export function indexToolImages(
  items: readonly StreamItem[],
  autoExpandReasoning: boolean | undefined,
  previous?: ToolImageRun,
) {
  const byItemId = new Map<string, readonly ToolCallImage[]>();
  let last = previous?.last ?? null;
  let toolName = previous?.toolName ?? null;
  let retained = previous?.images ?? [];
  let added: ToolCallImage[] = [];

  const publish = () => {
    if (added.length === 0) return retained;
    const images = [...retained, ...added];
    for (const image of images) byItemId.set(image.itemId, images);
    return images;
  };
  const endRun = () => {
    publish();
    last = null;
    toolName = null;
    retained = [];
    added = [];
  };

  for (const item of items) {
    if (last && isTurnBoundary(last, item)) endRun();
    if (isGroupableToolCall(item, autoExpandReasoning)) {
      if (item.kind === "tool_call") toolName = describeToolCall(item).name;
      last = item;
      continue;
    }
    const images = item.kind === "assistant_message" ? collectToolCallImages([item], toolName) : [];
    if (item.kind === "assistant_message" && images.length > 0) {
      if (last) {
        added.push(...images);
        last = item;
      } else {
        // A lone image message has no tool run; it keeps its own numbering.
        byItemId.set(item.id, images);
      }
    } else {
      endRun();
    }
  }
  return { byItemId, pending: { last, toolName, images: publish() } };
}
