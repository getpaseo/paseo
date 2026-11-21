import { prepareMarkdownSource, type MarkdownImage } from "@/components/markdown/source";
import type { AssistantMessageItem } from "@/types/stream";
import type { ToolCallImage } from "./model";

const imagesByMessage = new WeakMap<AssistantMessageItem, readonly MarkdownImage[]>();

/** Only rendered thumbnails acquire parsed sources; hidden history retains message references. */
export function resolveToolCallImage(image: ToolCallImage): MarkdownImage {
  let parsed = imagesByMessage.get(image.message);
  if (!parsed) {
    parsed = prepareMarkdownSource(image.message.text).images;
    imagesByMessage.set(image.message, parsed);
  }
  const source = parsed[image.index];
  if (!source) throw new Error(`Missing provider image ${image.index} in ${image.itemId}`);
  return source;
}
