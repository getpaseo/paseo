import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";

interface MountedStream {
  host: HTMLDivElement;
  root: Root;
}

const mountedStreams: MountedStream[] = [];
const COMPLETED_HISTORY_MESSAGE_STYLE = {
  alignSelf: "center",
  height: 24,
  maxWidth: MAX_CONTENT_WIDTH,
  width: "100%",
};

function historyMessage(): StreamItem {
  return {
    kind: "user_message",
    id: "history-message",
    text: "Historical message",
    timestamp: new Date("2026-07-29T00:00:00.000Z"),
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  for (const { host, root } of mountedStreams.splice(0)) {
    root.unmount();
    host.remove();
  }
});

describe("web stream mounted history", () => {
  it("keeps an already-completed message centered in the conversation column", async () => {
    await page.viewport(1200, 800);

    const host = document.createElement("div");
    host.style.cssText = "width:1200px;height:600px;display:flex;flex-direction:column";
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedStreams.push({ host, root });

    const strategy = createWebStreamStrategy({ isMobileBreakpoint: false });
    const viewportRef = React.createRef<StreamViewportHandle>();
    flushSync(() => {
      root.render(
        strategy.render({
          agentId: "agent",
          segments: {
            historyVirtualized: [],
            historyMounted: [historyMessage()],
            liveHead: [],
          },
          boundary: {
            hasVirtualizedHistory: false,
            hasMountedHistory: true,
            hasLiveHead: false,
          },
          renderers: {
            renderHistoryVirtualizedRow: () => null,
            renderHistoryMountedRow: () => (
              <div
                data-testid="completed-history-message"
                style={COMPLETED_HISTORY_MESSAGE_STYLE}
              />
            ),
            renderLiveHeadRow: () => null,
            renderLiveAuxiliary: () => null,
          },
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: () => {},
          onNearHistoryStart: () => true,
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
    await nextFrame();

    const message = host.querySelector<HTMLElement>('[data-testid="completed-history-message"]');
    if (!message) {
      throw new Error("Expected completed history message");
    }
    const hostRect = host.getBoundingClientRect();
    const messageRect = message.getBoundingClientRect();

    expect(messageRect.width).toBe(MAX_CONTENT_WIDTH);
    expect(
      Math.abs(messageRect.left + messageRect.width / 2 - (hostRect.left + hostRect.width / 2)),
    ).toBeLessThan(1);
  });
});
