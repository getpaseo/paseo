import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Dimensions } from "react-native";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { usePanelStore } from "@/stores/panel-store";
import { MobilePanelsProvider, useIsMobilePanelActive, useMobilePanelsRuntime } from "./provider";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("renders a panel subscriber only when that panel settles or stops being settled", async () => {
  const initial = usePanelStore.getState();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const explorerStates: boolean[] = [];

  function ExplorerSubscriber() {
    explorerStates.push(useIsMobilePanelActive("file-explorer"));
    return null;
  }

  function AgentSubscriber() {
    const active = useIsMobilePanelActive("agent");
    return <span>{active ? "Agent settled" : "Agent covered"}</span>;
  }

  async function showPanel(target: "agent" | "agent-list" | "file-explorer") {
    await act(async () => {
      usePanelStore.setState((state) => ({
        mobilePanel: { target, revision: state.mobilePanel.revision + 1 },
      }));
    });
  }

  try {
    await showPanel("agent-list");
    await act(async () => {
      root.render(
        <MobilePanelsProvider>
          <ExplorerSubscriber />
          <AgentSubscriber />
        </MobilePanelsProvider>,
      );
    });

    await showPanel("agent");
    expect(host.textContent).toBe("Agent covered");
    await expect.poll(() => host.textContent).toBe("Agent settled");
    expect(explorerStates).toEqual([false]);

    await showPanel("file-explorer");
    expect(explorerStates).toEqual([false]);
    await expect.poll(() => explorerStates).toEqual([false, true]);
    await showPanel("agent");
    await expect.poll(() => explorerStates).toEqual([false, true, false]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    usePanelStore.setState(initial, true);
  }
});

it("updates gesture width without rendering dock subscribers on each resize", async () => {
  const initialWidth = window.innerWidth;
  const initialHeight = window.innerHeight;
  const root = createRoot(document.createElement("div"));
  const runtimes: ReturnType<typeof useMobilePanelsRuntime>[] = [];
  function Subscriber() {
    runtimes.push(useMobilePanelsRuntime());
    return null;
  }
  try {
    await page.viewport(1400, 800);
    await expect.poll(() => Dimensions.get("window").width).toBe(1400);
    await act(async () =>
      root.render(
        <MobilePanelsProvider>
          <Subscriber />
        </MobilePanelsProvider>,
      ),
    );
    const before = runtimes.length;
    const runtime = runtimes[before - 1]!;
    await act(async () => {
      await page.viewport(1300, 780);
      await expect.poll(() => runtime.windowWidth.value).toBe(1300);
    });
    expect(runtimes.length).toBe(before);
  } finally {
    await act(async () => root.unmount());
    await page.viewport(initialWidth, initialHeight);
  }
});
