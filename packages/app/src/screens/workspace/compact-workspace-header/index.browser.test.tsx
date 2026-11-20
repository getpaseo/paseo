import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PortalProvider } from "@gorhom/portal";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { WindowLayoutContext } from "@/window-layout/context";
import { WindowLayoutActionsHost } from "@/window-layout";
import { usePanelStore } from "@/stores/panel-store";
import { CompactWorkspaceHeader } from ".";
import { i18n } from "@/i18n/i18next";
import type { WindowLayout } from "@/window-layout";
void i18n;

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const initialPanel = usePanelStore.getState();
afterEach(async () => {
  await act(async () => root.render(null));
  usePanelStore.setState(initialPanel, true);
});
const geometry: WindowLayout = {
  bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  verticalBarEdge: "trailing",
  verticalBar: { x: 20, y: 20, width: 44, height: 400 },
  divisions: [],
};

it("updates compact header actions on panel changes without rendering the workspace owner", async () => {
  let ownerRenders = 0;
  function WorkspaceOwner({ focused = true, compact = true }) {
    ownerRenders++;
    return (
      <CompactWorkspaceHeader
        isRouteFocused={focused}
        isCompact={compact}
        serverId="test"
        isLoading={false}
        title="Workspace"
        subtitle="Project"
        isSubtitleDistinct
        explorerAction={null}
        inDesktopTitlebar={false}
        tabSwitcher={null}
        headerVariant="full"
      >
        <button type="button">Workspace menu</button>
      </CompactWorkspaceHeader>
    );
  }
  async function renderWorkspace(focused = true, compact = true) {
    await act(async () =>
      root.render(
        <PortalProvider>
          <WindowLayoutContext.Provider value={geometry}>
            <WindowLayoutActionsHost />
            <WorkspaceOwner focused={focused} compact={compact} />
          </WindowLayoutContext.Provider>
        </PortalProvider>,
      ),
    );
  }
  async function showPanel(target: "agent" | "agent-list" | "file-explorer") {
    await act(async () =>
      usePanelStore.setState((state) => ({
        mobilePanel: { ...state.mobilePanel, target, revision: state.mobilePanel.revision + 1 },
      })),
    );
  }
  const menu = page.getByRole("button", {
    name: "Workspace menu",
    exact: true,
    includeHidden: true,
  });
  await showPanel("agent");
  await renderWorkspace();
  await expect.element(menu).toBeVisible();
  const rendersBeforePanelChanges = ownerRenders;
  await showPanel("agent-list");
  await expect.element(menu).not.toBeVisible();
  await showPanel("agent");
  await expect.element(menu).toBeVisible();
  await showPanel("file-explorer");
  await expect.element(menu).not.toBeVisible();
  expect(ownerRenders).toBe(rendersBeforePanelChanges);
  await renderWorkspace(true, false);
  await expect.element(menu).toBeVisible();
  await renderWorkspace(false, false);
  await expect.element(menu).not.toBeVisible();
});
