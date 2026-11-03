import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

// One timeline fetch sends its entries in one WebSocket message, so every item must stay small.
// Budgets count UTF-16 units plus a fixed cost per node; neither is exact JSON bytes. They bound
// long strings and long arrays, not wide objects (every entry is kept) or multi-byte text.
const TOOL_CALL_BUDGET = 64 * 1024;
const ITEM_BUDGET = 256 * 1024;
const NODE_COST = 8;
const MARKER_COST = 32;
// Ids, names, paths and queries stay whole, so an item keeps its identity across passes.
const SHORT_STRING = 1024;
const MAX_DEPTH = 64;

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (serializedBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

/** A sliced string can keep the entire provider output alive. Copy only the retained UTF-16
 * units, including an unmatched surrogate at the existing character limit. */
function retainTextPrefix(text: string, length: number): string {
  return Buffer.from(text.slice(0, length), "utf16le").toString("utf16le");
}

function formatSize(units: number): string {
  if (units < 1024) return `${units} B`;
  if (units < 1024 * 1024) return `${(units / 1024).toFixed(1)} KB`;
  return `${(units / (1024 * 1024)).toFixed(1)} MB`;
}

function truncatedMarker(units: number): string {
  return `…[truncated ${formatSize(units)}]`;
}

interface ItemSize {
  nodeCost: number;
  stringLengths: number[];
  tooDeep: boolean;
}

function measure(value: unknown, depth: number, size: ItemSize): void {
  size.nodeCost += NODE_COST;
  if (depth > MAX_DEPTH) {
    size.tooDeep = true;
  } else if (typeof value === "string") {
    size.stringLengths.push(value.length);
  } else if (Array.isArray(value)) {
    for (const element of value) measure(element, depth + 1, size);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      size.nodeCost += key.length;
      measure(child, depth + 1, size);
    }
  }
}

/** The largest per-string length that keeps all strings, once cut, within `available`. */
function findStringCap(lengths: readonly number[], available: number): number {
  let low = 0;
  let high = 0;
  for (const length of lengths) high = Math.max(high, length);
  while (low < high) {
    const cap = Math.ceil((low + high) / 2);
    let total = 0;
    for (const length of lengths) total += Math.min(length, cap);
    if (total <= available) low = cap;
    else high = cap - 1;
  }
  return low;
}

interface CutState {
  stringCap: number;
  remaining: number;
}

function cutString(text: string, cap: number): string {
  if (text.length <= cap) return text;
  // A partial data URL is useless to every reader, so drop it whole.
  if (text.startsWith("data:")) return truncatedMarker(text.length);
  return retainTextPrefix(text, cap) + truncatedMarker(text.length - cap);
}

function cut(value: unknown, depth: number, state: CutState): unknown {
  state.remaining -= NODE_COST;
  if (depth > MAX_DEPTH) return "…[truncated]";
  if (typeof value === "string") {
    const text = cutString(value, state.stringCap);
    state.remaining -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output: unknown[] = [];
    for (const element of value) {
      const remainingBefore = state.remaining;
      const next = cut(element, depth + 1, state);
      if (state.remaining < 0) {
        // Drop this and later elements. A marker element would break typed arrays.
        state.remaining = remainingBefore;
        changed = true;
        break;
      }
      changed ||= next !== element;
      output.push(next);
    }
    return changed ? output : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      state.remaining -= key.length;
      const next = cut(child, depth + 1, state);
      changed ||= next !== child;
      output[key] = next;
    }
    return changed ? output : value;
  }
  return value;
}

/** Returns the item itself when it fits its budget; otherwise a copy with its largest strings cut. */
export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  const budget = item.type === "tool_call" ? TOOL_CALL_BUDGET : ITEM_BUDGET;
  const size: ItemSize = { nodeCost: 0, stringLengths: [], tooDeep: false };
  measure(item, 0, size);
  let stringTotal = 0;
  for (const length of size.stringLengths) stringTotal += length;
  if (!size.tooDeep && size.nodeCost + stringTotal <= budget) return item;

  // Strings get what structure leaves, but at least half the budget, less a margin for JSON
  // escaping. Arrays drop the elements that do not fit, which bounds items whose short strings
  // or structure alone are too big.
  const markerCost =
    MARKER_COST * size.stringLengths.filter((length) => length > SHORT_STRING).length;
  const available = (budget * 15) / 16 - Math.min(size.nodeCost, budget / 2) - markerCost;
  const stringCap = Math.max(SHORT_STRING, findStringCap(size.stringLengths, available));
  return cut(item, 0, { stringCap, remaining: budget }) as AgentTimelineItem;
}
