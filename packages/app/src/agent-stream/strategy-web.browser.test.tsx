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

const rowStyleByHeight = new Map<number, { height: number }>();

function renderRow(item: StreamItem) {
  const height = item.kind === "user_message" ? Number(item.text) : ROW_HEIGHT;
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

function mountTimeline(historyMounted: StreamItem[], olderHistory?: OlderHistoryInput) {
  const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
  const viewportRef = React.createRef<StreamViewportHandle>();
  const input: StreamRenderInput = {
    agentId: "agent",
    segments: { historyVirtualized: [], historyMounted, liveHead: [] },
    boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
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
  const render = (segments: Partial<StreamRenderInput["segments"]>) =>
    root.render(strategy.render({ ...input, segments: { ...input.segments, ...segments } }));
  act(() => render({}));

  const scrollContainer = host.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  if (!scrollContainer) throw new Error("Expected agent chat scroll container");
  const rowElement = (id: string) => {
    const element = host.querySelector<HTMLElement>(`[data-history-row-id="${id}"]`);
    if (!element) throw new Error(`Expected row ${id}`);
    return element;
  };

  return {
    render: (segments: Partial<StreamRenderInput["segments"]>) => act(() => render(segments)),
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
    // Resize observers and the hold's settle run on animation frames.
    settle: () =>
      act(async () => {
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }),
  };
}

describe("web disclosure hold", () => {
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
      hasOlderHistory: true,
      olderHistoryProgressKey: "epoch:1",
      onNearHistoryStart: async () => {
        olderHistoryLoads += 1;
        return true;
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
