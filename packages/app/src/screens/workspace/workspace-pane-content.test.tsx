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

const tab: WorkspaceTabDescriptor = {
  key: "agent_agent-a",
  tabId: "agent_agent-a",
  kind: "agent",
  target: { kind: "agent", agentId: "agent-a" },
};

function buildContent() {
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
});
