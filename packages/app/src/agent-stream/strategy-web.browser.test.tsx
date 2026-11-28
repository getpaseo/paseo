import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import type { DisclosureTriggerEdge, StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const VIEWPORT_HEIGHT = 100;
const ROW_HEIGHT = 40;

// A row's height comes from its text, so a disclosure that opens or grows a row is a new item
// for that row, as it is in the app.
function row(index: number, height = ROW_HEIGHT): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: String(height),
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

function assistantRow(
  index: number,
  height = ROW_HEIGHT,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id: `assistant-${index}`,
    text: String(height),
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

function thoughtRow(index: number, height = ROW_HEIGHT): Extract<StreamItem, { kind: "thought" }> {
  return {
    kind: "thought",
    id: `thought-${index}`,
    text: String(height),
    status: "ready",
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

const rowStyleByHeight = new Map<number, { height: number }>();

function renderRow(item: StreamItem) {
  const height =
    item.kind === "user_message" || item.kind === "assistant_message" || item.kind === "thought"
      ? Number(item.text)
      : ROW_HEIGHT;
  let style = rowStyleByHeight.get(height);
  if (!style) {
    style = { height };
    rowStyleByHeight.set(height, style);
  }
  return <div style={style}>{item.id}</div>;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = `display:flex;flex-direction:column;width:500px;height:${VIEWPORT_HEIGHT}px`;
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

type OlderHistoryInput = Pick<
  StreamRenderInput,
  "onNearHistoryStart" | "hasOlderHistory" | "olderHistoryProgressKey"
>;

interface MountTimelineOptions {
  olderHistory?: OlderHistoryInput;
  isMobileBreakpoint?: boolean;
  historyVirtualized?: StreamItem[];
  viewportHeight?: number;
}

function mountTimeline(
  historyMounted: StreamItem[],
  {
    olderHistory,
    isMobileBreakpoint = true,
    historyVirtualized = [],
    viewportHeight = VIEWPORT_HEIGHT,
  }: MountTimelineOptions = {},
) {
  host.style.height = `${viewportHeight}px`;
  const strategy = createWebStreamStrategy({ isMobileBreakpoint });
  const viewportRef = React.createRef<StreamViewportHandle>();
  let currentInput: StreamRenderInput = {
    agentId: "agent",
    segments: { historyVirtualized, historyMounted, liveHead: [] },
    boundary: {
      hasVirtualizedHistory: historyVirtualized.length > 0,
      hasMountedHistory: historyMounted.length > 0,
      hasLiveHead: false,
    },
    renderers: {
      renderHistoryVirtualizedRow: renderRow,
      renderHistoryMountedRow: renderRow,
      renderLiveHeadRow: renderRow,
      renderLiveAuxiliary: () => null,
    },
    listEmptyComponent: null,
    viewportRef,
    routeBottomAnchorRequest: null,
    isAuthoritativeHistoryReady: true,
    onNearBottomChange: () => {},
    onNearHistoryStart: async () => true,
    isLoadingOlderHistory: false,
    hasOlderHistory: false,
    olderHistoryProgressKey: null,
    scrollEnabled: true,
    listStyle: null,
    baseListContentContainerStyle: null,
    forwardListContentContainerStyle: null,
    contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
    ...olderHistory,
  };
  const render = (
    segments: Partial<StreamRenderInput["segments"]>,
    overrides: Partial<Omit<StreamRenderInput, "segments">> = {},
  ) => {
    const nextSegments = { ...currentInput.segments, ...segments };
    currentInput = {
      ...currentInput,
      ...overrides,
      segments: nextSegments,
      boundary: {
        hasVirtualizedHistory: nextSegments.historyVirtualized.length > 0,
        hasMountedHistory: nextSegments.historyMounted.length > 0,
        hasLiveHead: nextSegments.liveHead.length > 0,
      },
    };
    root.render(strategy.render(currentInput));
  };
  act(() => render({}));

  const scrollContainer = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  if (!scrollContainer) throw new Error("Expected agent chat scroll container");
  const rowElement = (id: string) => {
    const element = host.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
    if (!element) throw new Error(`Expected row ${id}`);
    return element;
  };

  return {
    render: (
      segments: Partial<StreamRenderInput["segments"]>,
      overrides?: Partial<Omit<StreamRenderInput, "segments">>,
    ) => act(() => render(segments, overrides)),
    hold: (rowId: string, apply: () => void, triggerEdge: DisclosureTriggerEdge = "top") =>
      act(() => viewportRef.current!.holdRow(rowId, apply, triggerEdge)),
    rowTop: (id: string) =>
      rowElement(id).getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
    rowBottom: (id: string) =>
      rowElement(id).getBoundingClientRect().bottom - scrollContainer.getBoundingClientRect().top,
    scrollTo: (top: number) => {
      scrollContainer.scrollTop = top;
    },
    // A wheel listener runs before the browser applies the scroll the wheel causes.
    wheelUpTo: (top: number) => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
      scrollContainer.scrollTop = top;
    },
    distanceFromEnd: () =>
      scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop,
    scrollTop: () => scrollContainer.scrollTop,
    scrollUp: (distance: number) =>
      act(() => {
        scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -distance }));
        scrollContainer.scrollTop -= distance;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }),
    // Resize observers and the hold's settle run on animation frames.
    settle: (frames = 4) =>
      act(async () => {
        for (let frame = 0; frame < frames; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
  };
}

describe("web disclosure hold", () => {
  it.each([{ isMobileBreakpoint: true }, { isMobileBreakpoint: false }])(
    "keeps the reading position when mounted history becomes virtualized (compact: $isMobileBreakpoint)",
    async (options) => {
      const history = Array.from({ length: 80 }, (_, index) => row(index));
      const timeline = mountTimeline(history, options);
      await timeline.settle();
      timeline.scrollUp(600);
      await timeline.settle();
      const offset = timeline.scrollTop();
      const readingTop = timeline.rowTop("message-64");
      expect(offset).toBeGreaterThan(0);

      timeline.render({
        historyVirtualized: history.slice(0, 60),
        historyMounted: history.slice(60),
      });
      await timeline.settle();

      expect(timeline.scrollTop()).toBe(offset);
      expect(timeline.rowTop("message-64")).toBe(readingTop);
    },
  );

  it.each([{ isMobileBreakpoint: true }, { isMobileBreakpoint: false }])(
    "keeps following output when mounted history becomes virtualized at the end (compact: $isMobileBreakpoint)",
    async (options) => {
      const history = Array.from({ length: 80 }, (_, index) => row(index));
      const timeline = mountTimeline(history, options);
      await timeline.settle();

      timeline.render({
        historyVirtualized: history.slice(0, 60),
        historyMounted: history.slice(60),
      });
      await timeline.settle();
      expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);

      timeline.render({
        historyVirtualized: history.slice(0, 60),
        historyMounted: history.slice(60),
        liveHead: [row(80)],
      });
      await timeline.settle();
      expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
    },
  );

  it("keeps the trigger's top when an anchored toggle at the bottom opens rows below it, and stops following", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
    const triggerTop = timeline.rowTop("message-5");

    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 5), row(7, 200), history[5]!] }),
    );
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);
  });

  it("keeps the trigger's top when its row grows while following output", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const triggerTop = timeline.rowTop("message-5");

    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
    );
    await timeline.settle();
    expect(timeline.rowTop("message-5")).toBe(triggerTop);
  });

  // A long message's show more sits under the text it opens, on the bottom edge of its row.
  it("keeps the bottom of a bottom-trigger row through show more and show less while following output", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    const triggerBottom = timeline.rowBottom("message-5");

    timeline.hold(
      "message-5",
      () => timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
      "bottom",
    );
    await timeline.settle();
    expect(timeline.rowBottom("message-5")).toBe(triggerBottom);

    timeline.hold("message-5", () => timeline.render({ historyMounted: history }), "bottom");
    await timeline.settle();
    expect(timeline.rowBottom("message-5")).toBe(triggerBottom);
  });

  it("keeps the bottom of a bottom-trigger row through show more and show less when scrolled up", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.scrollTo(60);
    await timeline.settle();
    // message-2 is cut off at the top; message-3 is fully in view.
    for (const index of [2, 3]) {
      const triggerBottom = timeline.rowBottom(`message-${index}`);
      const grown = history.map((item, position) =>
        position === index - 1 ? row(index, 240) : item,
      );

      timeline.hold(`message-${index}`, () => timeline.render({ historyMounted: grown }), "bottom");
      await timeline.settle();
      expect(timeline.rowBottom(`message-${index}`)).toBe(triggerBottom);

      timeline.hold(
        `message-${index}`,
        () => timeline.render({ historyMounted: history }),
        "bottom",
      );
      await timeline.settle();
      expect(timeline.rowBottom(`message-${index}`)).toBe(triggerBottom);
    }
  });

  it("resumes following when collapsing an anchored row lands back at the end", async () => {
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history);
    await timeline.settle();
    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 4), row(5, 240), history[5]!] }),
    );
    await timeline.settle();

    timeline.hold("message-5", () => timeline.render({ historyMounted: history }));
    await timeline.settle();

    timeline.render({ liveHead: [row(8)] });
    await timeline.settle();
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);
  });
});

describe("web history start", () => {
  it("loads older history when an upward wheel lands at the start after the reader stopped following", async () => {
    let olderHistoryLoads = 0;
    const history = [1, 2, 3, 4, 5, 6].map((index) => row(index));
    const timeline = mountTimeline(history, {
      olderHistory: {
        hasOlderHistory: true,
        olderHistoryProgressKey: "epoch:1",
        onNearHistoryStart: async () => {
          olderHistoryLoads += 1;
          return true;
        },
      },
    });
    await timeline.settle();
    // Opening a row at the bottom stops following output without any scroll.
    timeline.hold("message-5", () =>
      timeline.render({ historyMounted: [...history.slice(0, 5), row(7, 200), history[5]!] }),
    );
    await timeline.settle();
    expect(olderHistoryLoads).toBe(0);

    timeline.wheelUpTo(0);
    await timeline.settle();

    expect(olderHistoryLoads).toBe(1);
  });
});

describe("web virtualizer reconcile stability", () => {
  it("settles without nested update loops when virtualized rows grow far past estimates above a mounted anchor", async () => {
    const mounted = Array.from({ length: 10 }, (_, index) => row(500 + index));
    const timeline = mountTimeline(mounted, { viewportHeight: 200 });
    await timeline.settle();
    timeline.scrollUp(200);
    await timeline.settle();
    const readingTop = timeline.rowTop("message-500");

    const virtualized = Array.from({ length: 500 }, (_, index) => thoughtRow(index, 800));
    timeline.render({ historyVirtualized: virtualized, historyMounted: mounted });
    await timeline.settle();

    expect(timeline.rowTop("message-500")).toBe(readingTop);
    expect(timeline.rowBottom("thought-499")).toBe(readingTop);
  });

  it("does not overflow React update depth via reconcileReadingPosition when growing virtualized rows reach the start on desktop", async () => {
    const mounted = Array.from({ length: 10 }, (_, index) => row(400 + index));
    const timeline = mountTimeline(mounted, {
      viewportHeight: 200,
      isMobileBreakpoint: false,
    });
    await timeline.settle();
    timeline.scrollUp(200);
    await timeline.settle();
    const readingTop = timeline.rowTop("message-400");

    const virtualized = Array.from({ length: 170 }, (_, index) => thoughtRow(index, 800));
    timeline.render({ historyVirtualized: virtualized, historyMounted: mounted });
    await timeline.settle();

    expect(timeline.rowTop("message-400")).toBe(readingTop);
    expect(timeline.rowBottom("thought-169")).toBe(readingTop);
  });

  it("does not runaway-loop when unmeasured virtualized rows shrink near the bottom of a long chat", async () => {
    const virtualized = Array.from({ length: 2000 }, (_, index) => assistantRow(index, 20));
    const mounted = Array.from({ length: 10 }, (_, index) => row(2000 + index, 40));
    const timeline = mountTimeline(mounted, {
      historyVirtualized: virtualized,
      viewportHeight: 600,
    });
    await timeline.settle(10);
    timeline.scrollUp(120);
    await timeline.settle(10);

    const readingTop = timeline.rowTop("message-2000");
    timeline.render({}, { contentMaxWidth: 360 });
    await timeline.settle(10);

    expect(timeline.rowTop("message-2000")).toBe(readingTop);
    expect(timeline.rowBottom("assistant-1999")).toBe(readingTop);
    expect(timeline.rowTop("assistant-1990")).toBe(readingTop - 200);
  });

  it("keeps a mounted anchor near the bottom when prepended virtualized rows shrink below estimate", async () => {
    const mounted = Array.from({ length: 10 }, (_, index) => row(40 + index, 40));
    const timeline = mountTimeline(mounted, { viewportHeight: 200 });
    await timeline.settle();
    timeline.scrollUp(60);
    await timeline.settle();
    const readingTop = timeline.rowTop("message-44");

    const virtualized = Array.from({ length: 40 }, (_, index) => assistantRow(index, 40));
    timeline.render({ historyVirtualized: virtualized, historyMounted: mounted });
    await timeline.settle();

    expect(timeline.rowTop("message-44")).toBe(readingTop);
    expect(timeline.rowBottom("assistant-39")).toBe(timeline.rowTop("message-40"));
  });

  it("settles across frames without hitting React update depth limits for hundreds of tiny virtualized rows", async () => {
    const mounted = Array.from({ length: 4 }, (_, index) => row(800 + index, 40));
    const virtualized = Array.from({ length: 800 }, (_, index) => assistantRow(index, 2));
    const timeline = mountTimeline(mounted, {
      historyVirtualized: virtualized,
      viewportHeight: 1200,
    });
    await timeline.settle(16);
    expect(timeline.distanceFromEnd()).toBeLessThanOrEqual(1);

    const readingTop = timeline.rowTop("message-800");
    timeline.hold("message-800", () => timeline.render({}, { contentMaxWidth: 360 }));
    await timeline.settle(16);

    expect(timeline.rowTop("message-800")).toBe(readingTop);
    expect(timeline.rowBottom("assistant-799")).toBe(readingTop);
    expect(timeline.rowTop("assistant-700")).toBe(readingTop - 200);
  });

  it("resumes following when a layout commit precedes the scroll event at the bottom", async () => {
    const mounted = Array.from({ length: 10 }, (_, index) => row(index, 40));
    const timeline = mountTimeline(mounted, { viewportHeight: 200 });
    await timeline.settle();
    timeline.scrollUp(120);
    await timeline.settle();

    timeline.scrollTo(1000);
    timeline.render({ historyMounted: [...mounted] });
    await timeline.settle();

    timeline.render({ liveHead: [row(10, 40)] });
    await timeline.settle();

    expect(timeline.distanceFromEnd()).toBe(0);
  });

  it("mounts the top of a newly virtualized block when all history fits in the viewport", async () => {
    const timeline = mountTimeline([row(99, 40)], {
      viewportHeight: 1200,
      isMobileBreakpoint: false,
    });
    await timeline.settle();

    timeline.render({
      historyVirtualized: Array.from({ length: 24 }, (_, index) => thoughtRow(index, 40)),
    });
    await timeline.settle();

    expect(timeline.scrollTop()).toBe(0);
    expect(timeline.rowTop("thought-0")).toBe(48);
    expect(timeline.rowTop("message-99")).toBe(48 + 24 * 40);
  });

  it("mounts the top of a newly virtualized block when a mounted row shrinks in the same commit", async () => {
    const timeline = mountTimeline([row(99, 1100)], {
      viewportHeight: 1200,
      isMobileBreakpoint: false,
    });
    await timeline.settle();
    expect(timeline.scrollTop()).toBe(0);

    timeline.render({
      historyVirtualized: Array.from({ length: 24 }, (_, index) => thoughtRow(index, 40)),
      historyMounted: [row(99, 40)],
    });
    await timeline.settle();

    expect(timeline.scrollTop()).toBe(0);
    expect(timeline.rowTop("message-99")).toBe(1008);
    expect(timeline.rowTop("thought-0")).toBe(48);
  });
});
