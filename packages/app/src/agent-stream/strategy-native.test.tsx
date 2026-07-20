/**
 * @vitest-environment jsdom
 */
import React, { forwardRef, useImperativeHandle } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutChangeEvent } from "react-native";
import type { StreamItem } from "@/types/stream";
import type { StreamSegmentRenderers, StreamViewportHandle } from "./strategy";

const scrollToIndex = vi.fn();
const scrollToOffset = vi.fn();
const measureInWindow = vi.fn(
  (callback: (x: number, y: number, width: number, height: number) => void) => {
    callback(0, 120, 320, 400);
  },
);
interface MockFlatListProps {
  data: unknown[];
  onLayout?: (event: LayoutChangeEvent) => void;
}
let latestFlatListProps: MockFlatListProps | null = null;

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  const MockFlatList = forwardRef<unknown, MockFlatListProps>(function MockFlatList(props, ref) {
    latestFlatListProps = props;
    useImperativeHandle(
      ref,
      () => ({
        getNativeScrollRef: () => ({ measureInWindow }),
        scrollToIndex,
        scrollToOffset,
      }),
      [],
    );
    return React.createElement("div", { "data-testid": "mock-flat-list" }, props.data.length);
  });
  return { ...actual, FlatList: MockFlatList };
});

const { createNativeStreamStrategy } = await import("./strategy-native");

function userMessage(index: number): StreamItem {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: `Message ${index}`,
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

function createRenderers(): StreamSegmentRenderers {
  return {
    renderHistoryVirtualizedRow: (item) => React.createElement("div", null, item.id),
    renderHistoryMountedRow: (item) => React.createElement("div", null, item.id),
    renderLiveHeadRow: (item) => React.createElement("div", null, item.id),
    renderLiveAuxiliary: () => null,
  };
}

describe("createNativeStreamStrategy scrollToItem", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    scrollToIndex.mockClear();
    scrollToOffset.mockClear();
    measureInWindow.mockClear();
    latestFlatListProps = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("scrolls to the index of a matched history item and returns true", () => {
    const strategy = createNativeStreamStrategy();
    const viewportRef = React.createRef<StreamViewportHandle>();
    const historyMounted = [userMessage(1), userMessage(2), userMessage(3)];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          agentId: "agent",
          segments: { historyVirtualized: [], historyMounted, liveHead: [] },
          boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
          renderers: createRenderers(),
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: vi.fn(),
          onNearHistoryStart: vi.fn(),
          isLoadingOlderHistory: false,
          hasOlderHistory: false,
          scrollEnabled: true,
          listStyle: null,
          baseListContentContainerStyle: null,
          forwardListContentContainerStyle: null,
        }),
      );
    });

    let didScroll = false;
    act(() => {
      didScroll = viewportRef.current?.scrollToItem("message-2") ?? false;
    });

    expect(didScroll).toBe(true);
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ animated: false, index: 1, viewPosition: 0.5 }),
    );
    viewportRef.current?.scrollBy(36);
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 36 });
  });

  it("reports the measured FlatList center in window coordinates", async () => {
    const strategy = createNativeStreamStrategy();
    const viewportRef = React.createRef<StreamViewportHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          agentId: "agent",
          segments: { historyVirtualized: [], historyMounted: [], liveHead: [] },
          boundary: { hasVirtualizedHistory: false, hasMountedHistory: false, hasLiveHead: false },
          renderers: createRenderers(),
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: vi.fn(),
          onNearHistoryStart: vi.fn(),
          isLoadingOlderHistory: false,
          hasOlderHistory: false,
          scrollEnabled: true,
          listStyle: null,
          baseListContentContainerStyle: null,
          forwardListContentContainerStyle: null,
        }),
      );
    });

    expect(viewportRef.current?.getWindowCenterY()).toBeNull();
    act(() => {
      latestFlatListProps?.onLayout?.({
        nativeEvent: { layout: { height: 400, width: 320, x: 0, y: 120 } },
      } as LayoutChangeEvent);
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(measureInWindow).toHaveBeenCalledTimes(1);
    expect(viewportRef.current?.getWindowCenterY()).toBe(320);
  });

  it("returns false for an item id that isn't in the rendered history rows", () => {
    const strategy = createNativeStreamStrategy();
    const viewportRef = React.createRef<StreamViewportHandle>();
    const historyMounted = [userMessage(1), userMessage(2)];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          agentId: "agent",
          segments: { historyVirtualized: [], historyMounted, liveHead: [] },
          boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
          renderers: createRenderers(),
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: vi.fn(),
          onNearHistoryStart: vi.fn(),
          isLoadingOlderHistory: false,
          hasOlderHistory: false,
          scrollEnabled: true,
          listStyle: null,
          baseListContentContainerStyle: null,
          forwardListContentContainerStyle: null,
        }),
      );
    });

    let didScroll = true;
    act(() => {
      didScroll = viewportRef.current?.scrollToItem("message-not-rendered") ?? true;
    });

    expect(didScroll).toBe(false);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
