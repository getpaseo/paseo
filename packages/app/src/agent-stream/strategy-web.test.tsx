/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamSegmentRenderers, StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

const mockSettingsState = vi.hoisted(() => ({
  promptScrollMarkers: true,
}));

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

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({
    settings: {
      promptScrollMarkers: mockSettingsState.promptScrollMarkers,
    },
  }),
}));

vi.mock("@/components/use-web-scrollbar", () => ({ useWebElementScrollbar: () => null }));

function userMessage(index: number, text = `Message ${index}`): StreamItem {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text,
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

function assistantMessage(index: number): StreamItem {
  return {
    kind: "assistant_message",
    id: `assistant-${index}`,
    text: `Assistant ${index}`,
    timestamp: new Date(`2026-04-20T00:01:${String(index % 60).padStart(2, "0")}.000Z`),
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

function renderViewport(input: {
  root: Root;
  isMobileBreakpoint?: boolean;
  promptScrollMarkers?: boolean;
  historyVirtualized?: StreamItem[];
  historyMounted?: StreamItem[];
  liveHead?: StreamItem[];
  onNearHistoryStart?: () => void;
}) {
  const strategy = createWebStreamStrategy({
    isMobileBreakpoint: input.isMobileBreakpoint ?? false,
  });
  const viewportRef = React.createRef<StreamViewportHandle>();
  const historyVirtualized = input.historyVirtualized ?? [];
  const historyMounted = input.historyMounted ?? [];
  const liveHead = input.liveHead ?? [];
  mockSettingsState.promptScrollMarkers = input.promptScrollMarkers ?? true;

  act(() => {
    input.root.render(
      <>
        {strategy.render({
          agentId: "agent",
          segments: {
            historyVirtualized,
            historyMounted,
            liveHead,
          },
          boundary: {
            hasVirtualizedHistory: historyVirtualized.length > 0,
            hasMountedHistory: historyMounted.length > 0,
            hasLiveHead: liveHead.length > 0,
          },
          renderers: createRenderers(vi.fn()),
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: vi.fn(),
          onNearHistoryStart: input.onNearHistoryStart ?? vi.fn(),
          isLoadingOlderHistory: false,
          hasOlderHistory: Boolean(input.onNearHistoryStart),
          scrollEnabled: true,
          listStyle: null,
          baseListContentContainerStyle: null,
          forwardListContentContainerStyle: null,
        })}
      </>,
    );
  });

  return viewportRef;
}

function setScrollableMetrics(input: {
  scrollContainer: Element;
  viewportHeight: number;
  contentHeight: number;
  scrollTop?: number;
}) {
  Object.defineProperty(input.scrollContainer, "clientHeight", {
    configurable: true,
    value: input.viewportHeight,
  });
  Object.defineProperty(input.scrollContainer, "scrollHeight", {
    configurable: true,
    value: input.contentHeight,
  });
  Object.defineProperty(input.scrollContainer, "scrollTop", {
    configurable: true,
    value: input.scrollTop ?? 0,
  });
}

function setElementOffsetTop(element: Element, offsetTop: number) {
  Object.defineProperty(element, "offsetTop", {
    configurable: true,
    value: offsetTop,
  });
}

function refreshScrollMetrics(scrollContainer: Element) {
  act(() => {
    scrollContainer.dispatchEvent(new Event("scroll"));
  });
}

function getRequiredElement(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected ${selector} to match an HTMLElement`);
  }
  return element;
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
            onNearHistoryStart: vi.fn(),
            isLoadingOlderHistory: false,
            hasOlderHistory: false,
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

  it("fires near-history-start when the user scrolls near the top", async () => {
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const onNearHistoryStart = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <>
          {strategy.render({
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
            onNearHistoryStart,
            isLoadingOlderHistory: false,
            hasOlderHistory: true,
            scrollEnabled: true,
            listStyle: null,
            baseListContentContainerStyle: null,
            forwardListContentContainerStyle: null,
          })}
        </>,
      );
    });

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    expect(scrollContainer).toBeInstanceOf(HTMLElement);
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 64 });

    act(() => {
      scrollContainer?.dispatchEvent(new Event("scroll"));
    });

    expect(onNearHistoryStart).toHaveBeenCalledTimes(1);
  });

  it("renders one desktop marker for each loaded user prompt", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1), assistantMessage(1), userMessage(2)],
      liveHead: [userMessage(3)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    for (const [index, anchor] of Array.from(
      container.querySelectorAll("[data-stream-item-id]"),
    ).entries()) {
      setElementOffsetTop(anchor, index * 160);
    }
    refreshScrollMetrics(scrollContainer);

    expect(container.querySelectorAll("[data-testid^='prompt-scroll-marker-']")).toHaveLength(3);
  });

  it("does not render prompt markers on compact web", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      isMobileBreakpoint: true,
      historyMounted: [userMessage(1), userMessage(2)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    refreshScrollMetrics(scrollContainer);

    expect(container.querySelector("[data-testid='prompt-marker-rail']")).toBeNull();
  });

  it("does not render prompt markers when the appearance setting is disabled", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      promptScrollMarkers: false,
      historyMounted: [userMessage(1), userMessage(2)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    refreshScrollMetrics(scrollContainer);

    expect(container.querySelector("[data-testid='prompt-marker-rail']")).toBeNull();
  });

  it("reveals a user prompt preview while hovering a marker", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    const anchor = getRequiredElement(container, "[data-stream-item-id='message-1']");
    setElementOffsetTop(anchor, 240);
    refreshScrollMetrics(scrollContainer);

    const marker = getRequiredElement(container, "[data-testid='prompt-scroll-marker-message-1']");
    const preview = getRequiredElement(
      container,
      "[data-testid='prompt-scroll-preview-message-1']",
    );
    expect(preview.style.opacity).toBe("0");

    act(() => {
      marker.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(preview.style.opacity).toBe("1");
    expect(preview.textContent).toBe("Message 1");
  });

  it("keeps mounted stream item anchors from breaking centered row layout", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1)],
      liveHead: [userMessage(2)],
    });

    const mountedAnchor = getRequiredElement(container, "[data-stream-item-id='message-1']");
    const liveAnchor = getRequiredElement(container, "[data-stream-item-id='message-2']");

    expect(mountedAnchor.style.display).toBe("flex");
    expect(mountedAnchor.style.flexDirection).toBe("column");
    expect(mountedAnchor.style.width).toBe("100%");
    expect(liveAnchor.style.display).toBe("flex");
    expect(liveAnchor.style.flexDirection).toBe("column");
    expect(liveAnchor.style.width).toBe("100%");
  });

  it("truncates long prompt previews with three periods", () => {
    const longPrompt = `${"Outline the generation process in a diagram. ".repeat(8)}Finish here`;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1, longPrompt)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    const anchor = getRequiredElement(container, "[data-stream-item-id='message-1']");
    setElementOffsetTop(anchor, 240);
    refreshScrollMetrics(scrollContainer);

    const preview = getRequiredElement(
      container,
      "[data-testid='prompt-scroll-preview-message-1']",
    );

    expect(preview.textContent?.endsWith("...")).toBe(true);
    expect(preview.textContent).not.toContain("Finish here");
  });

  it("keeps prompt previews padded inside the viewport edges", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    const anchor = getRequiredElement(container, "[data-stream-item-id='message-1']");
    setElementOffsetTop(anchor, 0);
    refreshScrollMetrics(scrollContainer);

    const marker = getRequiredElement(container, "[data-testid='prompt-scroll-marker-message-1']");
    const preview = getRequiredElement(
      container,
      "[data-testid='prompt-scroll-preview-message-1']",
    );
    const markerTop = Number.parseFloat(marker.style.top);
    const previewTop = markerTop + Number.parseFloat(preview.style.top);

    expect(previewTop).toBeGreaterThanOrEqual(16);
    expect(previewTop + 120).toBeLessThanOrEqual(384);
  });

  it("aligns prompt preview top with the visible dot top when unclamped", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    const anchor = getRequiredElement(container, "[data-stream-item-id='message-1']");
    setElementOffsetTop(anchor, 600);
    refreshScrollMetrics(scrollContainer);

    const marker = getRequiredElement(container, "[data-testid='prompt-scroll-marker-message-1']");
    const preview = getRequiredElement(
      container,
      "[data-testid='prompt-scroll-preview-message-1']",
    );
    const markerTop = Number.parseFloat(marker.style.top);
    const previewTop = markerTop + Number.parseFloat(preview.style.top);

    expect(previewTop - markerTop).toBe(11);
  });

  it("positions prompt markers from the top of the user message in the content", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 432 });
    const anchor = getRequiredElement(container, "[data-stream-item-id='message-1']");
    setElementOffsetTop(anchor, 16);
    refreshScrollMetrics(scrollContainer);

    const marker = getRequiredElement(container, "[data-testid='prompt-scroll-marker-message-1']");
    const markerTop = Number.parseFloat(marker.style.top);

    expect(markerTop).toBeLessThan(20);
  });

  it("scrolls a mounted prompt near the top with padding when its marker is clicked", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyMounted: [userMessage(1), userMessage(2)],
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1200 });
    const anchor = getRequiredElement(container, "[data-stream-item-id='message-2']");
    setElementOffsetTop(anchor, 320);
    refreshScrollMetrics(scrollContainer);
    vi.mocked(HTMLElement.prototype.scrollTo).mockClear();

    const marker = getRequiredElement(container, "[data-testid='prompt-scroll-marker-message-2']");
    act(() => {
      marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
      top: 305,
      behavior: "auto",
    });
  });

  it("scrolls a virtualized prompt using the virtualizer offset with top padding", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renderViewport({
      root,
      historyVirtualized: Array.from({ length: 8 }, (_, index) => userMessage(index)),
    });

    const scrollContainer = getRequiredElement(container, '[data-testid="agent-chat-scroll"]');
    setScrollableMetrics({ scrollContainer, viewportHeight: 400, contentHeight: 1600 });
    refreshScrollMetrics(scrollContainer);
    vi.mocked(HTMLElement.prototype.scrollTo).mockClear();

    const marker = getRequiredElement(container, "[data-testid='prompt-scroll-marker-message-3']");
    act(() => {
      marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
      top: 273,
      behavior: "auto",
    });
  });
});
