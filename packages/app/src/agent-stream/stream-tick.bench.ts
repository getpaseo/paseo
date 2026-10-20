import { bench, describe } from "vitest";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";
import { findMountedWindowStart, getMountedRecentStreamItems } from "./history-window";
import { layoutStream } from "./layout";
import { buildAgentStreamRenderModel } from "./model";
import { resolveStreamRenderStrategy } from "./strategy-resolver";

// One coalesced delta replaces the stream head. This is the pure work AgentStreamView
// does per delta on a long timeline, without React:
//   npx vitest bench --project unit src/agent-stream/stream-tick.bench.ts

const TIMELINE_ITEMS = 2_000;
const TICKS = 200;

function timestamp(seed: number): Date {
  return new Date(1_700_000_000_000 + seed * 1000);
}

function toolCall(id: string, seed: number): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: timestamp(seed),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: id },
      },
    },
  };
}

function buildTimeline(count: number): StreamItem[] {
  const items: StreamItem[] = [];
  let seed = 0;
  while (items.length < count) {
    const turn = items.length;
    items.push({
      kind: "user_message",
      id: `u${turn}`,
      text: "prompt",
      timestamp: timestamp(seed++),
    });
    items.push(toolCall(`t${turn}a`, seed++));
    items.push(toolCall(`t${turn}b`, seed++));
    items.push({
      kind: "assistant_message",
      id: `a${turn}`,
      text: "answer",
      timestamp: timestamp(seed++),
    });
  }
  return items.slice(0, count);
}

function buildHeads(base: StreamItem[], ticks: number): StreamItem[][] {
  let text = "";
  const heads: StreamItem[][] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    text += "token ";
    heads.push([
      {
        kind: "assistant_message",
        id: "live",
        text,
        timestamp: timestamp(base.length + tick),
      },
    ]);
  }
  return heads;
}

function runTicks(input: { tail: StreamItem[]; historyStart: number; heads: StreamItem[][] }) {
  const { tail, historyStart, heads } = input;
  const strategy = resolveStreamRenderStrategy({ platform: "web", isMobileBreakpoint: false });
  const prepared = prepareToolCallHistory("overview", tail);
  const boundaryId = tail[historyStart]?.id ?? null;
  const activeTurnStartedAt = tail.at(-1)?.timestamp ?? null;
  for (const head of heads) {
    const projected = projectToolCallDetailLevel({
      level: "overview",
      tail,
      head,
      preparedHistory: prepared,
      isTurnActive: true,
    });
    const boundaryIndex = boundaryId
      ? projected.tail.findIndex((item) => item.id === boundaryId)
      : -1;
    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt,
      tail: projected.tail,
      head: projected.head,
      platform: "web",
      isMobileBreakpoint: false,
      historyStart: boundaryIndex >= 0 ? boundaryIndex : historyStart,
    });
    layoutStream({
      strategy,
      isTurnActive: true,
      history: model.history,
      liveHead: model.segments.liveHead,
      timingByAssistantId: model.turnTiming.byAssistantId,
    });
  }
}

const tail = buildTimeline(TIMELINE_ITEMS);
const heads = buildHeads(tail, TICKS);
const defaultWindowStart = findMountedWindowStart({
  items: tail,
  minMountedCount: getMountedRecentStreamItems(),
});

describe(`${TICKS} streamed deltas over a ${TIMELINE_ITEMS}-item timeline`, () => {
  bench("default mounted window (recent items only)", () => {
    runTicks({ tail, historyStart: defaultWindowStart, heads });
  });
  bench("history fully revealed (scrolled to top)", () => {
    runTicks({ tail, historyStart: 0, heads });
  });
});
