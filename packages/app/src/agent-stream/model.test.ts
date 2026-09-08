import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import { findMountedWindowStart } from "./history-window";
import { buildAgentStreamRenderModel } from "./model";

function createTimestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

function assistantMessage(id: string, seed: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

describe("buildAgentStreamRenderModel", () => {
  it("projects a bounded recent turn-aligned history window on every platform", () => {
    const tail = [
      userMessage("u1", 1),
      assistantMessage("a1", 2),
      userMessage("u2", 3),
      assistantMessage("a2", 4),
      userMessage("u3", 5),
      assistantMessage("a3", 6),
    ];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
      historyStart: 2,
    });

    expect(model.history.map((item) => item.id)).toEqual(["a3", "u3", "a2", "u2"]);
    expect(model.segments.historyVirtualized).toHaveLength(0);
  });

  it("derives timing only for the rendered history window", () => {
    const tail = [
      userMessage("hidden-u", 1),
      assistantMessage("hidden-a", 2),
      userMessage("visible-u", 3),
      assistantMessage("visible-a", 4),
    ];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "web",
      isMobileBreakpoint: false,
      historyStart: 2,
    });

    expect(model.turnTiming.byAssistantId.has("hidden-a")).toBe(false);
    expect(model.turnTiming.byAssistantId.get("visible-a")).toEqual({
      completedAt: tail[3]?.timestamp,
      durationMs: 1000,
    });
  });

  it("keeps the mounted boundary stable when a transformer filters an earlier item", () => {
    const tail = [
      userMessage("filtered", 1),
      assistantMessage("hidden", 2),
      userMessage("visible-u", 3),
      assistantMessage("visible-a", 4),
    ];

    const projectedTail = projectPluginTimelineItems(tail, ({ sourceId }) =>
      sourceId === "filtered" ? [] : undefined,
    );
    const historyStart = findMountedWindowStart({ items: projectedTail, minMountedCount: 2 });
    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: projectedTail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
      historyStart,
    });

    expect(model.history.map((item) => item.id)).toEqual(["visible-a", "visible-u"]);
  });

  it("keeps head separate from committed history on desktop web", () => {
    const tail: StreamItem[] = [];
    for (let index = 0; index < 60; index += 1) {
      const seed = index * 2;
      tail.push(userMessage(`u${index}`, seed + 1));
      tail.push(assistantMessage(`a${index}`, seed + 2));
    }
    const head = [assistantMessage("live-a", 121)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail.at(-2)?.timestamp ?? null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.segments.historyVirtualized.length).toBeGreaterThan(0);
    expect(model.segments.historyMounted.length).toBeGreaterThan(0);
    expect(model.segments.liveHead.map((item) => item.id)).toEqual(["live-a"]);
    expect(model.history).not.toContain(head[0]);
  });

  it("keeps the full committed tail mounted on mobile web", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 2)];
    const head = [assistantMessage("live-a", 3)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: true,
    });

    expect(model.segments.historyVirtualized).toHaveLength(0);
    expect(model.segments.historyMounted).toBe(tail);
    expect(model.segments.liveHead).toBe(head);
  });

  it("reuses ordered committed history when only the live head changes", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 2)];
    const firstHead = [assistantMessage("live-a", 3)];
    const secondHead = [assistantMessage("live-b", 4)];

    const first = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head: firstHead,
      platform: "native",
      isMobileBreakpoint: false,
    });
    const second = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head: secondHead,
      platform: "native",
      isMobileBreakpoint: false,
    });

    expect(first.history).toBe(second.history);
    expect(first.segments.historyMounted).toBe(second.segments.historyMounted);
    expect(second.segments.liveHead.map((item) => item.id)).toEqual(["live-b"]);
  });

  it("derives running turn timing across committed history and live head", () => {
    const tail = [userMessage("u1", 1)];
    const head = [assistantMessage("live-a", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.turnTiming.runningStartedAt).toBe(tail[0]?.timestamp);
    expect(model.turnTiming.byAssistantId.has("live-a")).toBe(false);
  });

  it("maps completed turn timing to assistant ids across committed history and live head", () => {
    const tail = [userMessage("u1", 1)];
    const head = [assistantMessage("live-a", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.turnTiming.runningStartedAt).toBe(null);
    expect(model.turnTiming.byAssistantId.get("live-a")).toEqual({
      completedAt: head[0]?.timestamp,
      durationMs: 3000,
    });
  });

  it("derives the same timing for native inverted rendering", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
    });

    expect(model.segments.historyMounted.map((item) => item.id)).toEqual(["a1", "u1"]);
    expect(model.turnTiming.byAssistantId.get("a1")).toEqual({
      completedAt: tail[1]?.timestamp,
      durationMs: 3000,
    });
  });

  it("does not create completed timing for adjacent user messages", () => {
    const tail = [userMessage("u1", 1), userMessage("u2", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.turnTiming.byAssistantId.size).toBe(0);
  });
});
