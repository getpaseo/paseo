/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { StreamItem } from "@/types/stream";
import type { StreamRenderInput, StreamSegmentRenderers, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

vi.mock("react-native-unistyles", () => ({
  withUnistyles: (Component: React.ComponentType) => Component,
}));

function userMessage(index: number): StreamItem {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: `Message ${index}`,
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

const VIRTUAL_ROW_STYLE = { height: 24 };

function createRenderers(onRowRender: () => void): StreamSegmentRenderers {
  return {
    renderHistoryVirtualizedRow: (item) => {
      onRowRender();
      return <div style={VIRTUAL_ROW_STYLE}>{item.id}</div>;
    },
    renderHistoryMountedRow: (item) => <div>{item.id}</div>,
    renderLiveHeadRow: (item) => <div>{item.id}</div>,
    renderLiveAuxiliary: () => null,
  };
}

describe("createWebStreamStrategy", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let originalScrollTo: HTMLElement["scrollTo"] | undefined;
  let originalOffsetHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      configurable: true,
    });
    originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = vi.fn();
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 24;
      },
    });
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
    if (originalScrollTo) {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
    vi.restoreAllMocks();
  });

  it("mounts virtualized history without recursive row measurement updates", () => {
    const rowRenderCount = vi.fn();
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const historyVirtualized = Array.from({ length: 16 }, (_, index) => userMessage(index));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <>
          {strategy.render({
            agentId: "agent",
            segments: {
              historyVirtualized,
              historyMounted: [],
              liveHead: [],
            },
            boundary: {
              hasVirtualizedHistory: true,
              hasMountedHistory: false,
              hasLiveHead: false,
            },
            renderers: createRenderers(rowRenderCount),
            listEmptyComponent: null,
            viewportRef,
            routeBottomAnchorRequest: null,
            isAuthoritativeHistoryReady: true,
            onNearBottomChange: vi.fn(),
            onNearHistoryStart: vi.fn().mockReturnValue(true),
            isLoadingOlderHistory: false,
            hasOlderHistory: false,
            olderHistoryProgressKey: null,
            scrollEnabled: true,
            listStyle: null,
            baseListContentContainerStyle: null,
            forwardListContentContainerStyle: null,
          })}
        </>,
      );
    });

    expect(rowRenderCount.mock.calls.length).toBeGreaterThan(0);
    expect(rowRenderCount.mock.calls.length).toBeLessThanOrEqual(historyVirtualized.length);
  });

  it("rerenders a stable live-head row when its revision changes", () => {
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: false });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const liveHead = [userMessage(1)];
    let label = "collapsed";
    const renderLiveHeadRow = vi.fn(() => <div>{label}</div>);
    const renderInput: StreamRenderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted: [],
        liveHead,
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: false,
        hasLiveHead: true,
      },
      renderers: {
        ...createRenderers(vi.fn()),
        renderLiveHeadRow,
      },
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(strategy.render({ ...renderInput, liveHeadRowRevision: 0 }));
    });
    expect(container.textContent).toContain("collapsed");

    label = "expanded";
    act(() => {
      root?.render(strategy.render({ ...renderInput, liveHeadRowRevision: 1 }));
    });

    expect(container.textContent).toContain("expanded");
    expect(renderLiveHeadRow).toHaveBeenCalledTimes(2);
  });

  it("reports the live-head row as the reading position", () => {
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: false });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const onReadingPositionChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          agentId: "agent",
          segments: {
            historyVirtualized: [],
            historyMounted: [userMessage(1)],
            liveHead: [userMessage(2)],
          },
          boundary: {
            hasVirtualizedHistory: false,
            hasMountedHistory: true,
            hasLiveHead: true,
          },
          renderers: createRenderers(vi.fn()),
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: vi.fn(),
          onReadingPositionChange,
          onNearHistoryStart: vi.fn().mockReturnValue(true),
          isLoadingOlderHistory: false,
          hasOlderHistory: false,
          olderHistoryProgressKey: null,
          scrollEnabled: true,
          listStyle: null,
          baseListContentContainerStyle: null,
          forwardListContentContainerStyle: null,
        }),
      );
    });

    expect(onReadingPositionChange).toHaveBeenLastCalledWith("message-2");
  });

  it("keeps bottom anchoring through subpixel browser rounding", () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: false });
    const viewportRef = React.createRef<StreamViewportHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          agentId: "agent",
          segments: {
            historyVirtualized: [],
            historyMounted: [userMessage(1)],
            liveHead: [],
          },
          boundary: {
            hasVirtualizedHistory: false,
            hasMountedHistory: true,
            hasLiveHead: false,
          },
          renderers: createRenderers(vi.fn()),
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: vi.fn(),
          onNearHistoryStart: vi.fn().mockReturnValue(true),
          isLoadingOlderHistory: false,
          hasOlderHistory: false,
          olderHistoryProgressKey: null,
          scrollEnabled: true,
          listStyle: null,
          baseListContentContainerStyle: null,
          forwardListContentContainerStyle: null,
        }),
      );
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 766 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 5725 });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 4959.1708984375,
    });
    scrollTo.mockClear();

    act(() => {
      viewportRef.current?.scrollToBottom("message-sent");
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 5725, behavior: "auto" });

    scrollTo.mockClear();
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 4960.5,
    });

    act(() => {
      viewportRef.current?.scrollToBottom("message-sent");
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 5725, behavior: "auto" });

    scrollTo.mockClear();
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 4967,
    });

    act(() => {
      viewportRef.current?.scrollToBottom("message-sent");
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("waits for bottom anchoring before evaluating a delayed initial tail", async () => {
    HTMLElement.prototype.scrollTo = vi.fn(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      const top = typeof options === "object" ? (options.top ?? 0) : (y ?? 0);
      Object.defineProperty(this, "scrollTop", { configurable: true, value: top });
    });
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const onNearHistoryStart = vi.fn().mockReturnValue(true);
    const renderInput = {
      agentId: "agent",
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: false,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart,
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: { historyVirtualized: [], historyMounted: [], liveHead: [] },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 0 });

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            historyVirtualized: [],
            historyMounted: [userMessage(1), userMessage(2)],
            liveHead: [],
          },
          boundary: {
            hasVirtualizedHistory: false,
            hasMountedHistory: true,
            hasLiveHead: false,
          },
          hasOlderHistory: true,
          olderHistoryProgressKey: "epoch-1:20",
        }),
      );
    });

    expect(onNearHistoryStart).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(onNearHistoryStart).not.toHaveBeenCalled();
  });

  it("keeps initial route entry anchored when delayed route readiness arrives before user scroll", async () => {
    const scrollTo = vi.fn(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      const top = typeof options === "object" ? (options.top ?? 0) : (y ?? 0);
      Object.defineProperty(this, "scrollTop", {
        configurable: true,
        value: top,
      });
    });
    HTMLElement.prototype.scrollTo = scrollTo;

    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const routeBottomAnchorRequest = {
      agentId: "agent",
      reason: "initial-entry" as const,
      requestKey: "server:agent:initial-entry",
    };
    const renderInput = {
      agentId: "agent",
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: false,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            historyVirtualized: [],
            historyMounted: [],
            liveHead: [],
          },
          isAuthoritativeHistoryReady: false,
        }),
      );
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    const scrollElement = scrollContainer;
    Object.defineProperty(scrollElement, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollElement, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollElement, "scrollTop", { configurable: true, value: 0 });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    scrollTo.mockClear();

    const historyMounted = Array.from({ length: 20 }, (_, index) => userMessage(index));
    Object.defineProperty(scrollElement, "scrollHeight", { configurable: true, value: 1400 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            historyVirtualized: [],
            historyMounted,
            liveHead: [],
          },
          boundary: {
            hasVirtualizedHistory: false,
            hasMountedHistory: true,
            hasLiveHead: false,
          },
          isAuthoritativeHistoryReady: true,
        }),
      );
    });

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(scrollTo).toHaveBeenCalled();
    expect(scrollElement.scrollTop).toBe(1400);
  });

  it("does not force bottom on delayed route readiness after the user scrolls away", async () => {
    const scrollTo = vi.fn(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      const top = typeof options === "object" ? (options.top ?? 0) : (y ?? 0);
      Object.defineProperty(this, "scrollTop", {
        configurable: true,
        value: top,
      });
    });
    HTMLElement.prototype.scrollTo = scrollTo;

    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const historyMounted = Array.from({ length: 20 }, (_, index) => userMessage(index));
    const onNearHistoryStart = vi.fn().mockReturnValue(false);
    const routeBottomAnchorRequest = {
      agentId: "agent",
      reason: "initial-entry" as const,
      requestKey: "server:agent:initial-entry",
    };
    const renderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted,
        liveHead: [],
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: true,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart,
      isLoadingOlderHistory: false,
      hasOlderHistory: true,
      olderHistoryProgressKey: "epoch-1:20",
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          isAuthoritativeHistoryReady: false,
        }),
      );
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1000 });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    scrollTo.mockClear();

    act(() => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -240 }));
    });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 0 });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          isAuthoritativeHistoryReady: true,
        }),
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => Promise.resolve());
    expect(onNearHistoryStart).toHaveBeenCalledOnce();

    act(() => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -240 }));
    });
    await act(async () => Promise.resolve());
    expect(onNearHistoryStart).toHaveBeenCalledTimes(2);
  });

  it("does not force bottom after upward wheel when cached scroll top is stale", async () => {
    const scrollTo = vi.fn(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      const top = typeof options === "object" ? (options.top ?? 0) : (y ?? 0);
      Object.defineProperty(this, "scrollTop", {
        configurable: true,
        value: top,
      });
    });
    HTMLElement.prototype.scrollTo = scrollTo;

    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const historyMounted = Array.from({ length: 20 }, (_, index) => userMessage(index));
    const routeBottomAnchorRequest = {
      agentId: "agent",
      reason: "initial-entry" as const,
      requestKey: "server:agent:initial-entry",
    };
    const renderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted,
        liveHead: [],
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: true,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          isAuthoritativeHistoryReady: false,
        }),
      );
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1491 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 0 });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    scrollTo.mockClear();

    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 991 });
    act(() => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -900 }));
    });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 91 });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 0 });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2531 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          isAuthoritativeHistoryReady: true,
        }),
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("reattaches follow-output when a small scroll range returns to bottom", async () => {
    const scrollTo = vi.fn(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      const top = typeof options === "object" ? (options.top ?? 0) : (y ?? 0);
      Object.defineProperty(this, "scrollTop", {
        configurable: true,
        value: top,
      });
    });
    HTMLElement.prototype.scrollTo = scrollTo;

    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const renderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted: [userMessage(1), userMessage(2)],
        liveHead: [],
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: true,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest: null,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          isAuthoritativeHistoryReady: true,
        }),
      );
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 550 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 50 });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    scrollTo.mockClear();

    act(() => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
    });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 20 });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 50 });
    act(() => {
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    scrollTo.mockClear();

    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            ...renderInput.segments,
            liveHead: [userMessage(3)],
          },
          isAuthoritativeHistoryReady: true,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(scrollTo).toHaveBeenCalled();
  });

  it("keeps following output after geometry, nested-scroll, and zoom wheel events", () => {
    const scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === "object" ? (options.top ?? 0) : 0;
      Object.defineProperty(this, "scrollTop", { configurable: true, value: top });
    });
    HTMLElement.prototype.scrollTo = scrollTo;
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const renderInput: StreamRenderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted: [userMessage(1), userMessage(2)],
        liveHead: [],
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: true,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(strategy.render(renderInput)));
    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1500 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1000 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));

    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 700 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 800 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    scrollTo.mockClear();

    const nestedScroller = document.createElement("div");
    nestedScroller.style.overflowY = "auto";
    Object.defineProperty(nestedScroller, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(nestedScroller, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(nestedScroller, "scrollTop", { configurable: true, value: 100 });
    scrollContainer.append(nestedScroller);
    act(() => {
      nestedScroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
      Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 700 });
      scrollContainer.dispatchEvent(new Event("scroll"));
      scrollContainer.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: -100 }),
      );
    });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1800 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: { ...renderInput.segments, liveHead: [userMessage(3)] },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1800, behavior: "auto" });
  });

  it("stops following output after pointer-driven upward scrolling", () => {
    const scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === "object" ? (options.top ?? 0) : 0;
      Object.defineProperty(this, "scrollTop", { configurable: true, value: top });
    });
    HTMLElement.prototype.scrollTo = scrollTo;
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const renderInput: StreamRenderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted: [userMessage(1), userMessage(2)],
        liveHead: [],
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: true,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef: React.createRef<StreamViewportHandle>(),
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(strategy.render(renderInput)));
    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "clientWidth", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "offsetWidth", { configurable: true, value: 520 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1500 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1000 });
    scrollContainer.getBoundingClientRect = () =>
      ({
        bottom: 500,
        height: 500,
        left: 0,
        right: 520,
        top: 0,
        width: 520,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));

    const scrollbarPointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 515,
      clientY: 400,
    });
    Object.defineProperties(scrollbarPointerDown, {
      isPrimary: { value: true },
      pointerId: { value: 1 },
      pointerType: { value: "mouse" },
    });
    act(() => scrollContainer.dispatchEvent(scrollbarPointerDown));
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 700 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    scrollTo.mockClear();

    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1800 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: { ...renderInput.segments, liveHead: [userMessage(3)] },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1300 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    Object.defineProperty(scrollContainer, "offsetWidth", { configurable: true, value: 500 });
    scrollContainer.getBoundingClientRect = () =>
      ({
        bottom: 500,
        height: 500,
        left: 0,
        right: 500,
        top: 0,
        width: 500,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    const overlayScrollbarPointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 495,
      clientY: 400,
    });
    Object.defineProperties(overlayScrollbarPointerDown, {
      isPrimary: { value: true },
      pointerId: { value: 2 },
      pointerType: { value: "mouse" },
    });
    act(() => scrollContainer.dispatchEvent(overlayScrollbarPointerDown));
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 900 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    scrollTo.mockClear();

    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1900 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            ...renderInput.segments,
            liveHead: [userMessage(3), userMessage(4)],
          },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1400 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    const autoscrollPointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 1,
      buttons: 4,
      clientX: 100,
      clientY: 400,
    });
    const autoscrollPointerUp = new MouseEvent("pointerup", {
      bubbles: true,
      button: 1,
      buttons: 0,
      clientX: 100,
      clientY: 400,
    });
    const autoscrollPointerMove = new MouseEvent("pointermove", {
      bubbles: true,
      buttons: 0,
      clientX: 100,
      clientY: 300,
    });
    for (const event of [autoscrollPointerDown, autoscrollPointerUp, autoscrollPointerMove]) {
      Object.defineProperties(event, {
        isPrimary: { value: true },
        pointerId: { value: 3 },
        pointerType: { value: "mouse" },
      });
    }
    act(() => {
      scrollContainer.dispatchEvent(autoscrollPointerDown);
      window.dispatchEvent(autoscrollPointerUp);
      window.dispatchEvent(autoscrollPointerMove);
    });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1000 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    scrollTo.mockClear();

    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2000 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            ...renderInput.segments,
            liveHead: [userMessage(3), userMessage(4), userMessage(5)],
          },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();

    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1500 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 400,
    });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerId: { value: 4 },
      pointerType: { value: "mouse" },
    });
    const pointerMove = new MouseEvent("pointermove", {
      bubbles: true,
      buttons: 1,
      clientX: 100,
      clientY: 300,
    });
    Object.defineProperties(pointerMove, {
      isPrimary: { value: true },
      pointerId: { value: 4 },
      pointerType: { value: "mouse" },
    });
    act(() => {
      scrollContainer.dispatchEvent(pointerDown);
      window.dispatchEvent(pointerMove);
    });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1100 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    scrollTo.mockClear();

    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2200 });
    act(() => {
      root?.render(
        strategy.render({
          ...renderInput,
          segments: {
            ...renderInput.segments,
            liveHead: [userMessage(3), userMessage(4), userMessage(5), userMessage(6)],
          },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the retained viewport mounted while inactive and reconciles it once on return", () => {
    const observed = new Map<Element, ReturnType<typeof vi.fn>>();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        readonly disconnect = vi.fn();

        observe(target: Element) {
          observed.set(target, this.disconnect);
        }
      },
    });
    const scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
      const top = typeof options === "object" ? (options.top ?? 0) : 0;
      Object.defineProperty(this, "scrollTop", { configurable: true, value: top });
    });
    HTMLElement.prototype.scrollTo = scrollTo;
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const renderInput: StreamRenderInput = {
      agentId: "agent",
      segments: {
        historyVirtualized: [],
        historyMounted: [userMessage(1), userMessage(2)],
        liveHead: [],
      },
      boundary: {
        hasVirtualizedHistory: false,
        hasMountedHistory: true,
        hasLiveHead: false,
      },
      renderers: createRenderers(vi.fn()),
      listEmptyComponent: null,
      viewportRef,
      routeBottomAnchorRequest: null,
      isAuthoritativeHistoryReady: true,
      onNearBottomChange: vi.fn(),
      onNearHistoryStart: vi.fn().mockReturnValue(true),
      isLoadingOlderHistory: false,
      hasOlderHistory: false,
      olderHistoryProgressKey: null,
      scrollEnabled: true,
      listStyle: null,
      baseListContentContainerStyle: null,
      forwardListContentContainerStyle: null,
    };
    const renderWithActivity = (active: boolean, input: StreamRenderInput = renderInput) => (
      <RetainedPanelActivity active={active}>{strategy.render(input)}</RetainedPanelActivity>
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(renderWithActivity(true)));
    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected agent chat scroll container");
    }
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1500 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 1000 });
    act(() => scrollContainer.dispatchEvent(new Event("scroll")));
    const viewportObserverDisconnect = observed.get(scrollContainer);
    expect(viewportObserverDisconnect).toBeDefined();

    act(() => root?.render(renderWithActivity(false)));
    expect(container.querySelector('[data-testid="agent-chat-scroll"]')).toBe(scrollContainer);
    expect(viewportObserverDisconnect).toHaveBeenCalledOnce();
    scrollTo.mockClear();
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 2200 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 0 });
    act(() => {
      scrollContainer.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      scrollContainer.dispatchEvent(new Event("scroll"));
      root?.render(
        renderWithActivity(false, {
          ...renderInput,
          segments: { ...renderInput.segments, liveHead: [userMessage(3)] },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      root?.render(
        renderWithActivity(true, {
          ...renderInput,
          segments: { ...renderInput.segments, liveHead: [userMessage(3)] },
          boundary: { ...renderInput.boundary, hasLiveHead: true },
        }),
      );
    });
    expect(container.querySelector('[data-testid="agent-chat-scroll"]')).toBe(scrollContainer);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2200, behavior: "auto" });
  });
});
