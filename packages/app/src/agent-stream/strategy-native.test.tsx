/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamRenderInput, StreamViewportHandle } from "./strategy";
import { createNativeStreamStrategy } from "./strategy-native";

interface ListCallbacks {
  onLayout: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  onContentSizeChange: (width: number, height: number) => void;
  onReady: () => void;
  onScrollBeginDrag: (event: unknown) => void;
}

const fixture = vi.hoisted(() => ({
  list: null as ListCallbacks | null,
  controller: {
    mode: "sticky-bottom",
    beginUserScroll: vi.fn(),
    endUserScroll: vi.fn(),
    handleContentSizeChange: vi.fn(),
    handleScrollNearBottomChange: vi.fn(),
    handleViewportMetricsChange: vi.fn(),
    holdForDisclosure: vi.fn(),
    prepareForStickyViewportChange: vi.fn(),
    releaseDisclosure: vi.fn(),
    requestLocalAnchor: vi.fn(),
  },
}));

vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: ListCallbacks) => {
    fixture.list = props;
    return null;
  },
  useSyncLayout: () => () => {},
}));
vi.mock("./bottom-anchor-controller", () => ({
  useBottomAnchorController: () => fixture.controller,
}));
vi.mock("./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss", () => ({
  useScrollKeyboardDismiss: () => ({
    onScroll: () => {},
    onScrollBeginDrag: () => {},
    onScrollEndDrag: () => {},
  }),
}));
vi.mock("./native-end-pin", () => ({ EndPinnedScrollView: () => null }));
vi.mock("./top-overlay", () => ({ useStreamTopOverlayInset: () => 0 }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));

describe("native history pagination", () => {
  let root: Root;
  let container: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    fixture.list = null;
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function mount(onNearHistoryStart: () => boolean) {
    const input: StreamRenderInput = {
      agentId: "agent",
      segments: { historyVirtualized: [], historyMounted: [], liveHead: [] },
      boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
      renderers: {
        renderHistoryVirtualizedRow: () => null,
        renderHistoryMountedRow: () => null,
        renderLiveHeadRow: () => null,
        renderLiveAuxiliary: () => null,
      },
      listEmptyComponent: null,
      viewportRef: React.createRef<StreamViewportHandle>(),
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: () => {},
      onNearHistoryStart,
      isLoadingOlderHistory: false,
      hasOlderHistory: true,
      olderHistoryProgressKey: "epoch-1:20",
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
      contentMaxWidth: 800,
    };
    act(() => root.render(createNativeStreamStrategy().render(input)));
  }

  function flushFrame() {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((callback) => callback(0)));
  }

  function layout(height: number) {
    fixture.list!.onLayout({ nativeEvent: { layout: { width: 360, height } } });
  }

  it("loads once after the list is placed when measurements arrive first", async () => {
    const load = vi.fn(() => true);
    mount(load);
    flushFrame();
    act(() => {
      layout(600);
      fixture.list!.onContentSizeChange(360, 450);
    });
    expect(load).not.toHaveBeenCalled();

    await act(async () => fixture.list!.onReady());
    expect(load).toHaveBeenCalledTimes(1);
    act(() => fixture.list!.onContentSizeChange(360, 450));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads after measurement if the list was placed first", async () => {
    const load = vi.fn(() => true);
    mount(load);
    act(() => fixture.list!.onReady());
    flushFrame();
    act(() => layout(600));
    expect(load).not.toHaveBeenCalled();

    await act(async () => fixture.list!.onContentSizeChange(360, 450));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps requiring a drag when the history is scrollable", async () => {
    const load = vi.fn(() => true);
    mount(load);
    flushFrame();
    act(() => {
      fixture.list!.onReady();
      layout(600);
      fixture.list!.onContentSizeChange(360, 900);
    });
    expect(load).not.toHaveBeenCalled();

    await act(async () => fixture.list!.onScrollBeginDrag({}));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
