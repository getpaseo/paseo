/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamSegmentRenderers, StreamViewportHandle } from "./stream-strategy";
import { createWebStreamStrategy } from "./stream-strategy-web";

function userMessage(index: number): StreamItem {
  return {
    kind: "user_message",
    id: `message-${index}`,
    text: `Message ${index}`,
    timestamp: new Date(`2026-04-20T00:00:${String(index % 60).padStart(2, "0")}.000Z`),
  };
}

function createRenderers(onRowRender: () => void): StreamSegmentRenderers {
  return {
    renderHistoryVirtualizedRow: (item) => {
      onRowRender();
      return <div style={{ height: 24 }}>{item.id}</div>;
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
              historyToHeadGap: 0,
            },
            renderers: createRenderers(rowRenderCount),
            listEmptyComponent: null,
            viewportRef,
            routeBottomAnchorRequest: null,
            isAuthoritativeHistoryReady: true,
            onNearBottomChange: vi.fn(),
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
});
