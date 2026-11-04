import React, { act, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { usePanelStore } from "@/stores/panel-store";
import { createMobilePanelMotionState, transitionMobilePanel } from "./model";
import { subscribeMobilePanelSelection } from "./selection";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("receives layout commands published between render and subscription, then future commands", async () => {
  usePanelStore.getState().showMobileAgent();
  let motion = createMobilePanelMotionState(usePanelStore.getState().mobilePanel);
  function PublishLayout() {
    useLayoutEffect(() => {
      usePanelStore.getState().applyPanelLayout({ isCompact: false, leftSidebar: "hidden" });
    }, []);
    return null;
  }
  function Subscriber() {
    useEffect(
      () =>
        subscribeMobilePanelSelection((selection) => {
          motion = transitionMobilePanel(motion, { type: "command", selection }).state;
        }),
      [],
    );
    return <PublishLayout />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Subscriber />));
    expect(motion.revision).toBe(usePanelStore.getState().mobilePanel.revision);
    act(() => usePanelStore.getState().showMobileAgentList());
    expect(motion.target).toBe("agent-list");
    expect(motion.revision).toBe(usePanelStore.getState().mobilePanel.revision);
  } finally {
    act(() => root.unmount());
    container.remove();
    usePanelStore.getState().showMobileAgent();
  }
});
