import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { expect, it } from "vitest";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { ExplorerFrame } from "./frame";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const WORKSPACE_STYLE = { flexDirection: "row", height: 200 } as const;
const FILL = { flex: 1 };

it("measures dock allocation independently of the workspace owner", async () => {
  const host = document.createElement("div");
  host.style.width = "900px";
  document.body.appendChild(host);
  const root = createRoot(host);
  let workspaceRenders = 0;

  function Workspace() {
    workspaceRenders++;
    return (
      <View style={WORKSPACE_STYLE}>
        <View role="main" style={FILL} />
        <ExplorerFrame presentation="dock" isWorkspaceActive isOpen persistenceKey="workspace">
          <View role="complementary" style={FILL} />
        </ExplorerFrame>
      </View>
    );
  }

  function dockWidth() {
    return host.querySelector('[role="complementary"]')?.getBoundingClientRect().width;
  }

  try {
    await act(async () => {
      root.render(
        <MobilePanelsProvider>
          <Workspace />
        </MobilePanelsProvider>,
      );
    });
    await expect.poll(dockWidth).toBe(320);
    const initialRenderCount = workspaceRenders;
    const dock = host.querySelector('[role="complementary"]');
    host.style.width = "620px";
    await expect.poll(dockWidth).toBe(260);
    expect(workspaceRenders).toBe(initialRenderCount);
    expect(host.querySelector('[role="complementary"]')).toBe(dock);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
