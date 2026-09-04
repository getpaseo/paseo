import type { StreamItem } from "@/types/stream";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { getMarkdownListMarker } from "@/utils/markdown-list";
import type Token from "markdown-it/lib/token.mjs";

export interface SessionFindMatch {
  itemId: string;
  /** 0-based occurrence position within the item's searchable text. */
  occurrenceIndex: number;
}

export interface SessionFindState {
  query: string;
  activeItemId: string | null;
  activeOccurrenceIndex: number;
  /**
   * How many occurrences the match model found in the active item. Renderers
   * compare this against what they can enumerate to decide whether
   * `activeOccurrenceIndex` identifies the same occurrence they see.
   */
  activeItemOccurrenceCount: number;
}

const assistantMarkdownParser = createAssistantMarkdownParser();

function extractVisibleTokenText(token: Token): string {
  if (token.type === "image") {
    return "";
  }
  if (token.children) {
    return token.children.map(extractVisibleTokenText).join("");
  }
  switch (token.type) {
    case "text":
    case "code_inline":
    case "code_block":
    case "fence":
      return token.content;
    case "softbreak":
    case "hardbreak":
      return "\n";
    default:
      return "";
  }
}

/**
 * The list bullet and the ordered number are drawn by the renderer, not present
 * in the source, and they land in the row as ordinary text nodes (see the
 * `list_item` rule in `components/message.tsx`). Rebuilding them here through
 * the renderer's own marker function keeps the projection and the rendered row
 * in step, so a search for `1.` or a bullet matches, and the occurrence ordinals
 * of everything after a list still line up.
 */
interface ListMarkerFrame {
  listNode: { type: string; attributes?: { start?: number | string } };
  itemCount: number;
}

function openListFrame(token: Token): ListMarkerFrame {
  if (token.type === "ordered_list_open") {
    const start = token.attrGet("start");
    return {
      listNode: { type: "ordered_list", attributes: { start: start ?? undefined } },
      itemCount: 0,
    };
  }
  return { listNode: { type: "bullet_list" }, itemCount: 0 };
}

function extractVisibleMarkdownText(markdown: string): string {
  const listStack: ListMarkerFrame[] = [];
  let text = "";
  for (const token of assistantMarkdownParser.parse(markdown, {})) {
    switch (token.type) {
      case "ordered_list_open":
      case "bullet_list_open":
        listStack.push(openListFrame(token));
        break;
      case "ordered_list_close":
      case "bullet_list_close":
        listStack.pop();
        break;
      case "list_item_open": {
        const frame = listStack[listStack.length - 1];
        text += getMarkdownListMarker(
          { index: frame?.itemCount ?? 0, markup: token.markup },
          frame?.listNode,
        ).marker;
        if (frame) {
          frame.itemCount += 1;
        }
        break;
      }
      default:
        text += extractVisibleTokenText(token);
    }
  }
  return text;
}

/**
 * Text that is visible in the stream by default. Collapsed content (reasoning,
 * tool call inputs/outputs) is intentionally excluded so every match can be
 * scrolled to and seen without expanding anything.
 */
export function extractSearchableText(item: StreamItem): string {
  switch (item.kind) {
    case "user_message":
      return item.text;
    case "assistant_message":
      return extractVisibleMarkdownText(item.text);
    case "notification":
      return item.message;
    case "todo_list":
      return item.items.map((entry) => entry.text).join("\n");
    case "tool_call": {
      const { payload } = item;
      // Speak tool calls render inline as chat messages (see SpeakMessage).
      if (
        payload.source === "agent" &&
        payload.data.name === "speak" &&
        payload.data.detail.type === "unknown" &&
        typeof payload.data.detail.input === "string"
      ) {
        return payload.data.detail.input;
      }
      return "";
    }
    default:
      return "";
  }
}

// Stream items are immutable snapshots, so the lowercased text can be cached
// per item to keep per-keystroke matching cheap on long sessions.
const lowerCaseTextCache = new WeakMap<StreamItem, string>();

function getLowerCaseSearchableText(item: StreamItem): string {
  const cached = lowerCaseTextCache.get(item);
  if (cached !== undefined) {
    return cached;
  }
  const text = extractSearchableText(item).toLowerCase();
  lowerCaseTextCache.set(item, text);
  return text;
}

/**
 * Enumerates case-insensitive, non-overlapping occurrences of `query` across
 * the stream in display order.
 */
export function computeSessionFindMatches(
  items: readonly StreamItem[],
  query: string,
): SessionFindMatch[] {
  if (query.length === 0) {
    return [];
  }
  const needle = query.toLowerCase();
  const matches: SessionFindMatch[] = [];
  for (const item of items) {
    const haystack = getLowerCaseSearchableText(item);
    if (haystack.length === 0) {
      continue;
    }
    let occurrenceIndex = 0;
    let searchFrom = 0;
    while (true) {
      const foundAt = haystack.indexOf(needle, searchFrom);
      if (foundAt < 0) {
        break;
      }
      matches.push({ itemId: item.id, occurrenceIndex });
      occurrenceIndex += 1;
      searchFrom = foundAt + needle.length;
    }
  }
  return matches;
}
