/** @vitest-environment jsdom */
import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import { WorkspaceTabDragScope } from "./workspace-tab-drag-scope.web";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";

let dragProps: ComponentProps<typeof DndContext>;
// Drive the DnD event boundary directly so pointer geometry and animation timing are deterministic.
vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  DndContext: (props: ComponentProps<typeof DndContext>) => {
    dragProps = props;
    return props.children;
  },
  DragOverlay: () => null,
}));
vi.mock("@/screens/workspace/workspace-tab-presentation", () => ({
  WorkspaceTabPresentationResolver: () => null,
  WorkspaceTabIcon: () => null,
}));

let root: Root;
let container: HTMLElement;
const tabs: WorkspaceTab[] = ["a", "b", "c"].map((tabId) => ({
  tabId,
  target: { kind: "draft", draftId: tabId },
  createdAt: 0,
}));
function pane(id: string, tabIds: string[]) {
  return { kind: "pane" as const, pane: { id, tabIds, focusedTabId: tabIds[0] ?? null } };
}
function createLayout(crossPane: boolean): WorkspaceLayout {
  return {
    root: crossPane
      ? {
          kind: "group",
          group: {
            id: "group",
            direction: "horizontal",
            sizes: [0.5, 0.5],
            children: [pane("source", ["a"]), pane("target", ["b", "c"])],
          },
        }
      : pane("source", ["a", "b", "c"]),
    focusedPaneId: "source",
  };
}
function drag(sourcePaneId: string, targetPaneId: string): DragEndEvent {
  return {
    activatorEvent: new MouseEvent("pointerdown"),
    active: {
      id: "a",
      data: { current: { kind: "workspace-tab", paneId: sourcePaneId, tabId: "a" } },
      rect: {
        current: {
          initial: null,
          translated: { left: 110, top: 0, width: 40, height: 30, right: 150, bottom: 30 },
        },
      },
    },
    over: {
      id: "b",
      disabled: false,
      data: { current: { kind: "workspace-tab", paneId: targetPaneId, tabId: "b" } },
      rect: { left: 50, top: 0, width: 100, height: 30, right: 150, bottom: 30 },
    },
    collisions: null,
    delta: { x: 110, y: 0 },
  };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("WorkspaceTabDragScope shared ordering", () => {
  it.each([false, true])(
    "reports the dragged tab identity for a cross-pane=%s reorder",
    (crossPane) => {
      const sourcePaneId = "source";
      const targetPaneId = crossPane ? "target" : sourcePaneId;
      const layout = createLayout(crossPane);
      const onReorderTabsInPane = vi.fn();
      const onMoveTabToPane = vi.fn();
      act(() =>
        root.render(
          <WorkspaceTabDragScope
            layout={layout}
            explorerSidebarPaneId={null}
            allowCrossPane
            normalizedServerId="server"
            normalizedWorkspaceId="workspace"
            uiTabs={tabs}
            onReorderTabsInPane={onReorderTabsInPane}
            onMoveTabToPane={onMoveTabToPane}
            onSplitPane={vi.fn()}
          >
            <div />
          </WorkspaceTabDragScope>,
        ),
      );
      const event = drag(sourcePaneId, targetPaneId);
      act(() => dragProps.onDragStart?.(event));
      act(() => dragProps.onDragOver?.(event));
      act(() => dragProps.onDragEnd?.(event));
      expect(onReorderTabsInPane.mock.calls).toEqual([
        [
          {
            paneId: targetPaneId,
            tabIds: ["b", "a", "c"],
            movedTabId: "a",
          },
        ],
      ]);
      expect(onMoveTabToPane.mock.calls).toEqual(crossPane ? [["a", "target"]] : []);
    },
  );
});
