/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { usePaneContext, usePaneFocus, type PaneContextValue } from "@/panels/pane-context";
import { paneFindController } from "@/pane-find/pane-find-controller";

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: vi.fn(),
}));

vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => ({
    kind: "agent",
    component: ProbePanel,
    useDescriptor: vi.fn(),
  }),
}));

interface ProbeSnapshot {
  paneContextValue: PaneContextValue;
  focus: ReturnType<typeof usePaneFocus>;
}

const snapshots: ProbeSnapshot[] = [];
const mountCount = vi.fn();
const unmountCount = vi.fn();

function ProbePanel() {
  const paneContextValue = usePaneContext();
  const focus = usePaneFocus();
  snapshots.push({ paneContextValue, focus });

  useEffect(() => {
    mountCount();
    return () => {
      unmountCount();
    };
  }, []);

  return null;
}

const agentTab: WorkspaceTabDescriptor = {
  key: "agent_agent-a",
  tabId: "agent_agent-a",
  kind: "agent",
  target: { kind: "agent", agentId: "agent-a" },
};

function buildContent(tab: WorkspaceTabDescriptor = agentTab) {
  return buildWorkspacePaneContentModel({
    tab,
    normalizedServerId: "server-a",
    normalizedWorkspaceId: "workspace-a",
    onOpenTab: vi.fn(),
    onCloseCurrentTab: vi.fn(),
    onRetargetCurrentTab: vi.fn(),
    onOpenWorkspaceFile: vi.fn(),
    onOpenImportSheet: vi.fn(),
  });
}

describe("WorkspacePaneContent", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    snapshots.length = 0;
    mountCount.mockClear();
    unmountCount.mockClear();
    const focused = paneFindController.getFocusedPane();
    if (focused) {
      paneFindController.clearFocusedPaneIfCurrent(focused);
    }
  });

  it("centrally marks the pane find-focused only while workspace+pane focused", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const content = buildContent();
    const paneInstanceId = "server-a:workspace-a:agent_agent-a";
    expect(content.paneContextValue.paneInstanceId).toBe(paneInstanceId);

    // Pane not focused -> it is not the find-focused pane.
    act(() => {
      root?.render(
        <WorkspacePaneContent content={content} isPaneFocused={false} isWorkspaceFocused={true} />,
      );
    });
    expect(paneFindController.getFocusedPane()).not.toBe(paneInstanceId);

    // Focused -> it becomes the single find-focused pane.
    act(() => {
      root?.render(
        <WorkspacePaneContent content={content} isPaneFocused isWorkspaceFocused={true} />,
      );
    });
    expect(paneFindController.getFocusedPane()).toBe(paneInstanceId);

    // Blur -> ownership is released.
    act(() => {
      root?.render(
        <WorkspacePaneContent content={content} isPaneFocused={false} isWorkspaceFocused={true} />,
      );
    });
    expect(paneFindController.getFocusedPane()).not.toBe(paneInstanceId);
  });

  it("updates focus without remounting panel content or replacing pane identity", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const content = buildContent();

    act(() => {
      root?.render(
        <WorkspacePaneContent content={content} isPaneFocused={false} isWorkspaceFocused={true} />,
      );
    });
    act(() => {
      root?.render(
        <WorkspacePaneContent content={content} isPaneFocused isWorkspaceFocused={true} />,
      );
    });

    expect(mountCount).toHaveBeenCalledTimes(1);
    expect(unmountCount).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.paneContextValue).toBe(snapshots[0]?.paneContextValue);
    expect(snapshots[0]?.focus).toEqual({
      isWorkspaceFocused: true,
      isPaneFocused: false,
      isInteractive: false,
      focusPane: expect.any(Function),
    });
    expect(snapshots[1]?.focus).toEqual({
      isWorkspaceFocused: true,
      isPaneFocused: true,
      isInteractive: true,
      focusPane: expect.any(Function),
    });
  });

  it("keeps pane content mounted when a draft tab is retargeted in place", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const draftContent = buildContent({
      key: "draft-a",
      tabId: "draft-a",
      kind: "draft",
      target: { kind: "draft", draftId: "draft-a" },
    });
    const agentContent = buildContent({
      key: "draft-a",
      tabId: "draft-a",
      kind: "agent",
      target: { kind: "agent", agentId: "agent-a" },
    });

    act(() => {
      root?.render(
        <WorkspacePaneContent content={draftContent} isPaneFocused isWorkspaceFocused={true} />,
      );
    });
    act(() => {
      root?.render(
        <WorkspacePaneContent content={agentContent} isPaneFocused isWorkspaceFocused={true} />,
      );
    });

    expect(mountCount).toHaveBeenCalledTimes(1);
    expect(unmountCount).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.paneContextValue.tabId).toBe("draft-a");
    expect(snapshots[1]?.paneContextValue.target).toEqual({
      kind: "agent",
      agentId: "agent-a",
    });
  });
});
