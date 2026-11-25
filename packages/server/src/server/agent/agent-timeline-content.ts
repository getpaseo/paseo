import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { PluginIdSchema } from "@getpaseo/protocol/plugin-config";

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
const EDIT_CONTEXT_LINES = 3;
const EDIT_MAX_DIFF_DISTANCE = 256;

// The app registers renderer kinds under the plugin ID rule, so stored kinds must use that format.
export function assertPluginTimelineKind(kind: string): void {
  if (!PluginIdSchema.safeParse(kind).success) {
    throw new Error(
      `Plugin timeline item kind must start with a lowercase letter and contain only lowercase letters, digits, and dashes: ${JSON.stringify(kind)}`,
    );
  }
}

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

type EditToolCallDetail = Extract<
  Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
  { type: "edit" }
>;

interface EditDiffOp {
  kind: "eq" | "del" | "add";
  oldIdx: number;
  newIdx: number;
}

interface EditDiffSpan {
  oldLines: readonly string[];
  newLines: readonly string[];
  start: number;
  oldEnd: number;
  newEnd: number;
}

function splitEditLines(
  oldText: string,
  newText: string,
): {
  oldLines: string[];
  newLines: string[];
} {
  let normalizedOld = oldText.replace(/\r\n/g, "\n");
  let normalizedNew = newText.replace(/\r\n/g, "\n");
  if (normalizedOld.endsWith("\n") && normalizedNew.endsWith("\n")) {
    normalizedOld = normalizedOld.slice(0, -1);
    normalizedNew = normalizedNew.slice(0, -1);
  }
  return {
    oldLines: normalizedOld.split("\n"),
    newLines: normalizedNew.split("\n"),
  };
}

interface MyersTrace {
  trace: Int32Array[];
  distance: number;
  offset: number;
}

function shouldMoveDown(v: Int32Array, offset: number, d: number, k: number): boolean {
  return k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
}

function computeMyersTrace(span: EditDiffSpan): MyersTrace | null {
  const { oldLines, newLines, start, oldEnd, newEnd } = span;
  const oldLen = oldEnd - start;
  const newLen = newEnd - start;
  const maxDistance = Math.min(EDIT_MAX_DIFF_DISTANCE, oldLen + newLen);
  const offset = maxDistance;
  const v = new Int32Array(2 * maxDistance + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxDistance; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const moveDown = shouldMoveDown(v, offset, d, k);
      let x = moveDown ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < oldLen && y < newLen && oldLines[start + x] === newLines[start + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= oldLen && y >= newLen) {
        return { trace, distance: d, offset };
      }
    }
  }
  return null;
}

function diffLineSlice(span: EditDiffSpan): EditDiffOp[] | null {
  const result = computeMyersTrace(span);
  if (!result) return null;

  const { start, oldEnd, newEnd } = span;
  const { trace, distance, offset } = result;
  const reversed: EditDiffOp[] = [];
  let x = oldEnd - start;
  let y = newEnd - start;

  for (let d = distance; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    const moveDown = shouldMoveDown(prev, offset, d, k);
    const prevK = moveDown ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    const midX = moveDown ? prevX : prevX + 1;
    const midY = moveDown ? prevY + 1 : prevY;
    while (x > midX && y > midY) {
      x -= 1;
      y -= 1;
      reversed.push({ kind: "eq", oldIdx: start + x, newIdx: start + y });
    }
    reversed.push({
      kind: moveDown ? "add" : "del",
      oldIdx: start + prevX,
      newIdx: start + prevY,
    });
    x = prevX;
    y = prevY;
  }

  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ kind: "eq", oldIdx: start + x, newIdx: start + y });
  }
  reversed.reverse();
  return reversed;
}

function buildCompactUnifiedDiff(span: EditDiffSpan): string | null {
  const { oldLines, newLines, start, oldEnd, newEnd } = span;
  const middleOps = diffLineSlice(span);
  if (!middleOps) return null;

  const ops: EditDiffOp[] = [];
  const leadStart = Math.max(0, start - EDIT_CONTEXT_LINES);
  for (let i = leadStart; i < start; i += 1) {
    ops.push({ kind: "eq", oldIdx: i, newIdx: i });
  }
  for (const op of middleOps) ops.push(op);
  const trailCount = Math.min(EDIT_CONTEXT_LINES, oldLines.length - oldEnd);
  for (let i = 0; i < trailCount; i += 1) {
    ops.push({ kind: "eq", oldIdx: oldEnd + i, newIdx: newEnd + i });
  }

  const output: string[] = [];
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx].kind === "eq") idx += 1;
    if (idx >= ops.length) break;

    const hunkStart = Math.max(0, idx - EDIT_CONTEXT_LINES);
    let lastEdit = idx;
    idx += 1;
    while (idx < ops.length) {
      if (ops[idx].kind !== "eq") {
        lastEdit = idx;
        idx += 1;
        continue;
      }
      if (idx - lastEdit > EDIT_CONTEXT_LINES * 2) break;
      idx += 1;
    }
    const hunkEnd = Math.min(ops.length, lastEdit + EDIT_CONTEXT_LINES + 1);
    const hunkOps = ops.slice(hunkStart, hunkEnd);

    let oldCount = 0;
    let newCount = 0;
    for (const op of hunkOps) {
      if (op.kind !== "add") oldCount += 1;
      if (op.kind !== "del") newCount += 1;
    }
    const firstOp = hunkOps[0];
    const oldStart = oldCount === 0 ? firstOp.oldIdx : firstOp.oldIdx + 1;
    const newStart = newCount === 0 ? firstOp.newIdx : firstOp.newIdx + 1;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunkOps) {
      if (op.kind === "eq") output.push(` ${oldLines[op.oldIdx]}`);
      else if (op.kind === "del") output.push(`-${oldLines[op.oldIdx]}`);
      else output.push(`+${newLines[op.newIdx]}`);
    }
    idx = hunkEnd;
  }

  return output.join("\n");
}

/** Narrow full-file edit payloads before generic prefix cutting drops changes past the cap. */
function compactOversizedEditDetail(
  detail: EditToolCallDetail,
  maxTextBudget: number,
): EditToolCallDetail | null {
  if (detail.unifiedDiff) return null;
  const { oldString, newString } = detail;
  if (!oldString || !newString) return null;

  const { oldLines, newLines } = splitEditLines(oldString, newString);
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) {
    start += 1;
  }
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  if (start === oldEnd && start === newEnd) {
    return { ...detail, oldString: "", newString: "" };
  }

  const contextStart = Math.max(0, start - EDIT_CONTEXT_LINES);
  const oldContextEnd = Math.min(oldLines.length, oldEnd + EDIT_CONTEXT_LINES);
  const newContextEnd = Math.min(newLines.length, newEnd + EDIT_CONTEXT_LINES);
  const trimmedOld = oldLines.slice(contextStart, oldContextEnd).join("\n");
  const trimmedNew = newLines.slice(contextStart, newContextEnd).join("\n");

  if (trimmedOld.length + trimmedNew.length <= maxTextBudget) {
    if (trimmedOld.length >= oldString.length && trimmedNew.length >= newString.length) {
      return null;
    }
    return { ...detail, oldString: trimmedOld, newString: trimmedNew };
  }

  const unifiedDiff = buildCompactUnifiedDiff({ oldLines, newLines, start, oldEnd, newEnd });
  if (unifiedDiff && unifiedDiff.length < trimmedOld.length + trimmedNew.length) {
    return {
      type: "edit",
      filePath: detail.filePath,
      unifiedDiff,
    };
  }

  if (trimmedOld.length < oldString.length || trimmedNew.length < newString.length) {
    return { ...detail, oldString: trimmedOld, newString: trimmedNew };
  }
  return null;
}

function measureItem(item: AgentTimelineItem): { size: ItemSize; total: number } {
  const size: ItemSize = { nodeCost: 0, stringLengths: [], tooDeep: false };
  measure(item, 0, size);
  let stringTotal = 0;
  for (const length of size.stringLengths) stringTotal += length;
  return { size, total: size.nodeCost + stringTotal };
}

function computeStringCap(size: ItemSize, budget: number): number {
  // Strings get what structure leaves, but at least half the budget, less a margin for JSON
  // escaping. Arrays drop the elements that do not fit, which bounds items whose short strings
  // or structure alone are too big.
  const markerCost =
    MARKER_COST * size.stringLengths.filter((length) => length > SHORT_STRING).length;
  const available = (budget * 15) / 16 - Math.min(size.nodeCost, budget / 2) - markerCost;
  return Math.max(SHORT_STRING, findStringCap(size.stringLengths, available));
}

/** Returns the item itself when it fits its budget; otherwise a copy with its largest strings cut. */
export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  const budget = item.type === "tool_call" ? TOOL_CALL_BUDGET : ITEM_BUDGET;
  const initial = measureItem(item);
  if (!initial.size.tooDeep && initial.total <= budget) return item;

  let candidate = item;
  let stringCap = computeStringCap(initial.size, budget);
  if (item.type === "tool_call" && item.detail.type === "edit") {
    const { oldString, newString } = item.detail;
    if (
      !item.detail.unifiedDiff &&
      oldString &&
      newString &&
      (oldString.length > stringCap || newString.length > stringCap)
    ) {
      const compacted = compactOversizedEditDetail(item.detail, Math.floor((budget * 3) / 4));
      if (compacted) {
        candidate = { ...item, detail: compacted };
        const next = measureItem(candidate);
        if (!next.size.tooDeep && next.total <= budget) return candidate;
        stringCap = computeStringCap(next.size, budget);
      }
    }
  }

  return cut(candidate, 0, { stringCap, remaining: budget }) as AgentTimelineItem;
}
