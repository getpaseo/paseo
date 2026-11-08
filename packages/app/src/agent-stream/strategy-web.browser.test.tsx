import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import type { StreamRenderInput, StreamViewportHandle } from "./strategy";
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

function mountTimeline(historyMounted: StreamItem[]) {
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
    hold: (rowId: string, apply: () => void) =>
      act(() => viewportRef.current!.holdRow(rowId, apply)),
    rowTop: (id: string) =>
      rowElement(id).getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top,
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
