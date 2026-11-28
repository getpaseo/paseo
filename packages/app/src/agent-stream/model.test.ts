import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import { findMountedWindowStart } from "./history-window";
import { buildAgentStreamRenderModel } from "./model";
import { openPlanReview } from "./plan-review/model";
import { MAX_MOUNTED_WEB_WINDOW_ITEMS } from "./web-virtualization";

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

describe("plan review drafts", () => {
  it("retains line and whole-plan drafts when switching the compact comment target", () => {
    const model = openPlanReview("first\nsecond");
    expect(model.getState().commentTarget).toBe("plan");
    model.setField("feedback", "General note");
    model.selectLines(2);
    model.setField("text", "Line note");
    expect(model.getState().commentTarget).toBe("lines");
    model.setCommentTarget("plan");
    expect(model.getState()).toMatchObject({ text: "Line note", feedback: "General note" });
    model.setCommentTarget("lines");
    model.addComment();
    expect(model.getState()).toMatchObject({
      feedback: "General note",
      text: "",
      comments: [{ start: 2, end: 2, text: "Line note" }],
    });
    expect(model.requestChanges()).toEqual({
      behavior: "deny",
      selectedActionId: "request_changes",
      message: "Proposed plan lines 2-2:\n> second\n\nComment:\nLine note\n\nGeneral note",
    });
  });

  it("selects source lines in either direction and preserves comment drafts", () => {
    const model = openPlanReview("first\r\n\r\nthird");
    model.setField("text", "  Draft comment  ");
    model.setField("feedback", "Overall note");

    expect(model.selectLines(1, 3)).toBe(true);
    expect(model.getState()).toMatchObject({
      start: "1",
      end: "3",
      text: "  Draft comment  ",
      feedback: "Overall note",
    });
    expect(model.selectLines(3, 1)).toBe(true);
    expect(model.getState()).toMatchObject({
      start: "1",
      end: "3",
      text: "  Draft comment  ",
      feedback: "Overall note",
    });

    expect(model.selectLines(2)).toBe(true);
    expect(model.getState()).toMatchObject({ start: "2", end: "2" });
    model.setField("text", "  Blank line note  ");
    expect(model.requestChanges()).toMatchObject({
      behavior: "deny",
      message: "Proposed plan lines 2-2:\n> \n\nComment:\nBlank line note\n\nOverall note",
    });
  });

  it("rejects invalid line selections without changing selection or draft", () => {
    const model = openPlanReview("one\ntwo");
    model.setField("text", "Draft");
    model.selectLines(2, 1);
    const selected = model.getState();

    expect(model.selectLines(0)).toBe(false);
    expect(model.getState()).toMatchObject({
      start: selected.start,
      end: selected.end,
      text: "Draft",
      error: "invalidRange",
    });
    expect(model.selectLines(3)).toBe(false);
    expect(model.getState()).toMatchObject({
      start: selected.start,
      end: selected.end,
      text: "Draft",
      error: "invalidRange",
    });
    expect(model.selectLines(1.5)).toBe(false);
    expect(model.getState()).toMatchObject({
      start: selected.start,
      end: selected.end,
      text: "Draft",
      error: "invalidRange",
    });
    expect(model.selectLines(1, 2.5)).toBe(false);
    expect(model.getState()).toMatchObject({
      start: selected.start,
      end: selected.end,
      text: "Draft",
      error: "invalidRange",
    });
  });

  it("serializes the exact source quote after selecting lines", () => {
    const model = openPlanReview("first\r\nsecond\r\nthird");
    model.setField("text", "  Keep these lines.  ");

    expect(model.selectLines(2, 1)).toBe(true);
    expect(model.requestChanges()).toEqual({
      behavior: "deny",
      selectedActionId: "request_changes",
      message: "Proposed plan lines 1-2:\n> first\n> second\n\nComment:\nKeep these lines.",
    });
  });

  it("serializes trimmed comments with exact multiline CRLF source quotes", () => {
    const model = openPlanReview("first\r\nsecond\r\nthird");
    model.setField("start", "1");
    model.setField("end", "2");
    model.setField("text", "  Keep both lines.  ");

    expect(model.requestChanges()).toEqual({
      behavior: "deny",
      selectedActionId: "request_changes",
      message: "Proposed plan lines 1-2:\n> first\n> second\n\nComment:\nKeep both lines.",
    });
  });

  it("includes edited comments, excludes removed comments, and appends general feedback", () => {
    const model = openPlanReview("one\ntwo\nthree");
    model.setField("start", "1");
    model.setField("end", "1");
    model.setField("text", "First comment");
    model.addComment();
    model.setField("start", "2");
    model.setField("end", "3");
    model.setField("text", "Second comment");
    model.addComment();
    model.editComment(0, "Edited first comment");
    model.removeComment(1);
    model.setField("feedback", "  Overall feedback.  ");

    expect(model.requestChanges()).toEqual({
      behavior: "deny",
      selectedActionId: "request_changes",
      message:
        "Proposed plan lines 1-1:\n> one\n\nComment:\nEdited first comment\n\nOverall feedback.",
    });
  });

  it("includes an unsaved comment draft in the request", () => {
    const model = openPlanReview("one\ntwo");
    model.setField("start", "2");
    model.setField("end", "2");
    model.setField("text", "  Draft comment  ");

    expect(model.requestChanges()).toEqual({
      behavior: "deny",
      selectedActionId: "request_changes",
      message: "Proposed plan lines 2-2:\n> two\n\nComment:\nDraft comment",
    });
  });

  it("validates ranges and comments without discarding drafts", () => {
    const model = openPlanReview("one\ntwo");
    model.setField("start", "3");
    model.setField("end", "3");
    model.setField("text", "Draft comment");
    model.addComment();
    expect(model.getState()).toMatchObject({
      start: "3",
      end: "3",
      text: "Draft comment",
      comments: [],
      error: "invalidRange",
    });

    model.setField("start", "1");
    model.setField("end", "1");
    model.setField("text", "   ");
    model.addComment();
    expect(model.getState()).toMatchObject({ text: "   ", comments: [], error: "enterComment" });
  });

  it("rejects an empty request and retains feedback after validation failure", () => {
    const model = openPlanReview("one");
    expect(model.requestChanges()).toBeNull();
    expect(model.getState()).toMatchObject({ error: "enterFeedback" });

    model.setField("feedback", "  ");
    expect(model.requestChanges()).toBeNull();
    expect(model.getState()).toMatchObject({ feedback: "  ", error: "enterFeedback" });

    model.setField("feedback", "Please clarify.");
    expect(model.requestChanges()).toEqual({
      behavior: "deny",
      selectedActionId: "request_changes",
      message: "Please clarify.",
    });
    expect(model.getState()).toMatchObject({ feedback: "Please clarify.", error: null });
  });

  it("starts a fresh draft for a revised plan", () => {
    const original = openPlanReview("old plan");
    original.setField("text", "Old draft");
    original.setField("feedback", "Old feedback");

    const revised = openPlanReview("revised\nplan");
    expect(revised.numberedPlan).toBe("1  revised\n2  plan");
    expect(revised.getState()).toMatchObject({
      comments: [],
      start: "1",
      end: "1",
      text: "",
      feedback: "",
      error: null,
      hasFeedback: false,
    });
    expect(original.getState()).toMatchObject({ text: "Old draft", feedback: "Old feedback" });
  });
});

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

    expect(model.history.map((item) => item.id)).toEqual(["u2", "a2", "u3", "a3"]);
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

    expect(model.turnTiming.byItemId.has("hidden-a")).toBe(false);
    expect(model.turnTiming.byItemId.get("visible-a")).toEqual({
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

    expect(model.history.map((item) => item.id)).toEqual(["visible-u", "visible-a"]);
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

  it("virtualizes a desktop web turn that runs past the mounted cap", () => {
    const length = MAX_MOUNTED_WEB_WINDOW_ITEMS + 80;
    const tail = Array.from({ length }, (_, index) => ({
      ...userMessage(`row-${index}`, index % 60),
      turnId: "long-run",
    }));

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.segments.historyMounted).toHaveLength(MAX_MOUNTED_WEB_WINDOW_ITEMS);
    expect(model.segments.historyVirtualized).toHaveLength(80);
    expect(model.segments.historyMounted[0]?.id).toBe(
      `row-${length - MAX_MOUNTED_WEB_WINDOW_ITEMS}`,
    );
    expect(model.segments.historyVirtualized[0]?.id).toBe("row-0");
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
    expect(model.turnTiming.byItemId.has("live-a")).toBe(false);
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
    expect(model.turnTiming.byItemId.get("live-a")).toEqual({
      completedAt: head[0]?.timestamp,
      durationMs: 3000,
    });
  });

  it("derives the same timing on native", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
    });

    expect(model.segments.historyMounted.map((item) => item.id)).toEqual(["u1", "a1"]);
    expect(model.turnTiming.byItemId.get("a1")).toEqual({
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

    expect(model.turnTiming.byItemId.size).toBe(0);
  });

  it.each(["web", "native"] as const)(
    "reuses rendered history and timing across live-head updates inside a history window on %s",
    (platform) => {
      const at = (seed: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seed));
      const tail: StreamItem[] = [];
      for (let index = 0; index < 40; index += 1) {
        tail.push(
          { ...userMessage(`u${index}`, 0), timestamp: at(index * 2) },
          { ...assistantMessage(`a${index}`, 0), timestamp: at(index * 2 + 1) },
        );
      }
      const live = (text: string): StreamItem => ({
        kind: "assistant_message",
        id: "live",
        text,
        timestamp: at(81),
      });
      const build = (head: StreamItem[]) =>
        buildAgentStreamRenderModel({
          isTurnActive: true,
          activeTurnStartedAt: tail.at(-2)?.timestamp ?? null,
          tail,
          head,
          platform,
          isMobileBreakpoint: false,
          historyStart: 60,
        });

      const first = build([live("live")]);
      const second = build([live("live grows")]);

      expect(second.history).toBe(first.history);
      expect(second.segments.historyMounted).toBe(first.segments.historyMounted);
      expect(second.turnTiming.byItemId).toBe(first.turnTiming.byItemId);
      expect(first.history).toHaveLength(20);
      expect(first.turnTiming.byItemId.has("a29")).toBe(false);
      expect(first.turnTiming.byItemId.get("a38")).toEqual({
        completedAt: tail[77]?.timestamp,
        durationMs: 1000,
      });
    },
  );
});
