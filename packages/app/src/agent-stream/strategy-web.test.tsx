/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamSegmentRenderers, StreamViewportHandle } from "./strategy";
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

vi.mock("@/components/use-web-scrollbar", () => ({ useWebElementScrollbar: () => null }));

function userMessage(index: number): StreamItem {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: `Message ${index}`,
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
            pinUserInputsEnabled: false,
            onPinnedUserInputChange: vi.fn(),
            pinnedUserInputOverlay: null,
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
            pinUserInputsEnabled: false,
            onPinnedUserInputChange: vi.fn(),
            pinnedUserInputOverlay: null,
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

  it("reports a pinned user input and scrolls to its source row", () => {
    const strategy = createWebStreamStrategy({ isMobileBreakpoint: true });
    const viewportRef = React.createRef<StreamViewportHandle>();
    const onPinnedUserInputChange = vi.fn();
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
              historyMounted: [
                userMessage(1),
                assistantMessage(1),
                userMessage(2),
                assistantMessage(2),
              ],
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
            onNearHistoryStart: vi.fn(),
            pinUserInputsEnabled: true,
            onPinnedUserInputChange,
            pinnedUserInputOverlay: <div data-testid="pinned-user-input-overlay" />,
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

    const scrollContainer = container.querySelector('[data-testid="agent-chat-scroll"]');
    const firstUserRow = container.querySelector('[data-stream-item-id="message-1"]');
    const firstAssistantRow = container.querySelector('[data-stream-item-id="assistant-1"]');
    const secondUserRow = container.querySelector('[data-stream-item-id="message-2"]');
    const secondAssistantRow = container.querySelector('[data-stream-item-id="assistant-2"]');

    expect(scrollContainer).toBeInstanceOf(HTMLElement);
    expect(firstUserRow).toBeInstanceOf(HTMLElement);
    expect(firstAssistantRow).toBeInstanceOf(HTMLElement);
    expect(secondUserRow).toBeInstanceOf(HTMLElement);
    expect(secondAssistantRow).toBeInstanceOf(HTMLElement);
    expect(
      scrollContainer?.querySelector('[data-testid="pinned-user-input-overlay"]'),
    ).toBeInstanceOf(HTMLElement);

    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scrollContainer, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scrollContainer, "scrollTop", { configurable: true, value: 120 });
    Object.defineProperty(firstUserRow, "offsetTop", { configurable: true, value: 16 });
    Object.defineProperty(firstUserRow, "offsetHeight", { configurable: true, value: 80 });
    Object.defineProperty(firstAssistantRow, "offsetTop", { configurable: true, value: 120 });
    Object.defineProperty(firstAssistantRow, "offsetHeight", { configurable: true, value: 320 });
    Object.defineProperty(secondUserRow, "offsetTop", { configurable: true, value: 500 });
    Object.defineProperty(secondUserRow, "offsetHeight", { configurable: true, value: 80 });
    Object.defineProperty(secondAssistantRow, "offsetTop", { configurable: true, value: 610 });
    Object.defineProperty(secondAssistantRow, "offsetHeight", { configurable: true, value: 320 });

    act(() => {
      scrollContainer?.dispatchEvent(new Event("scroll"));
    });

    expect(onPinnedUserInputChange).toHaveBeenLastCalledWith({
      item: expect.objectContaining({ id: "message-1" }),
    });

    act(() => {
      viewportRef.current?.scrollToStreamItemTop("message-1");
    });

    expect(HTMLElement.prototype.scrollTo).toHaveBeenLastCalledWith({
      top: 1,
      behavior: "smooth",
    });
  });
});
