import type {
  AgentProvider,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../agent-sdk-types.js";
import type { MuseHostConnection, MuseHostNotification } from "./host.js";
import { asMuseViewItem, isRecord, type MuseViewItem } from "./items.js";
import { MuseNotificationFold, readReasoningText } from "./fold.js";
import { mapMuseToolCall } from "./tools.js";

const VIEW_PAGE_LIMIT = 500;
const VIEW_PAGE_MAX_PAGES = 100;

export function mapMuseHistoryItem(
  item: MuseViewItem,
  provider: AgentProvider,
): AgentStreamEvent | null {
  const turnId = typeof item.turnId === "string" ? { turnId: item.turnId } : {};
  let timeline: AgentTimelineItem | null = null;
  switch (item.kind) {
    case "userMessage": {
      const text =
        typeof item.displayText === "string" && item.displayText.length > 0
          ? item.displayText
          : typeof item.text === "string"
            ? item.text
            : "";
      if (text.length === 0) {
        return null;
      }
      timeline = { type: "user_message", text, messageId: item.itemId };
      break;
    }
    case "agentMessage": {
      const text = typeof item.text === "string" ? item.text : "";
      if (text.length === 0) {
        return null;
      }
      timeline = { type: "assistant_message", text, messageId: item.itemId };
      break;
    }
    case "reasoning": {
      const text = readReasoningText(item);
      if (text.length === 0) {
        return null;
      }
      timeline = { type: "reasoning", text };
      break;
    }
    case "toolCall":
    case "userShell": {
      timeline = mapMuseToolCall({ ...item, status: item.status ?? "completed" });
      break;
    }
    case "compaction": {
      timeline = { type: "compaction", status: "completed" };
      break;
    }
    default:
      return null;
  }
  return { type: "timeline", provider, item: timeline, ...turnId };
}

/**
 * Extract folded items from a `session/resume` history envelope. Returns null
 * when the envelope carries no items (`none` or an unknown mode), in which
 * case the caller pages the view itself.
 */
export function extractMuseHistoryItems(history: unknown): MuseViewItem[] | null {
  if (!isRecord(history)) {
    return null;
  }
  if (history["mode"] === "inline" && Array.isArray(history["items"])) {
    return history["items"].flatMap((entry) => {
      const item = asMuseViewItem(entry);
      return item ? [item] : [];
    });
  }
  if (history["mode"] === "snapshot" || history["mode"] === "anchoredSnapshot") {
    const snapshot = isRecord(history["snapshot"]) ? history["snapshot"] : undefined;
    const state = snapshot && isRecord(snapshot["state"]) ? snapshot["state"] : undefined;
    const items = state && Array.isArray(state["items"]) ? state["items"] : [];
    return items.flatMap((entry) => {
      const item = asMuseViewItem(entry);
      return item ? [item] : [];
    });
  }
  return null;
}

function asViewNotification(value: unknown): MuseHostNotification | null {
  if (!isRecord(value) || typeof value["method"] !== "string") {
    return null;
  }
  const params = isRecord(value["params"]) ? value["params"] : {};
  return { method: value["method"], params };
}

/**
 * Page a session view from the beginning and fold it into timeline events.
 * Used when resume serves no items. Paged events are unframed live
 * notifications, so the same fold reconstructs them.
 */
export async function pageMuseHistoryEvents(
  host: Pick<MuseHostConnection, "command">,
  sessionId: string,
  provider: AgentProvider,
  onDebug?: (message: string, data?: unknown) => void,
): Promise<AgentStreamEvent[]> {
  const fold = new MuseNotificationFold(provider, {
    onEvent: (event) => {
      if (event.type === "timeline" || event.type === "provider_subagent") {
        collected.push(event);
      }
    },
    onDebug,
  });
  const collected: AgentStreamEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < VIEW_PAGE_MAX_PAGES; page += 1) {
    const result = (await host.command("view/page", {
      sessionId,
      ...(cursor === undefined ? {} : { cursor }),
      direction: "forward",
      limit: VIEW_PAGE_LIMIT,
    })) as unknown;
    if (!isRecord(result) || !Array.isArray(result["events"])) {
      onDebug?.("Ignoring view/page result with an unexpected shape");
      break;
    }
    for (const entry of result["events"]) {
      const notification = asViewNotification(entry);
      if (notification) {
        fold.apply(notification);
      }
    }
    const nextCursor = result["nextCursor"];
    if (typeof nextCursor !== "string" || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return collected;
}
