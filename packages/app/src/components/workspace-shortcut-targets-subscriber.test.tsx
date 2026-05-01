/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import type { DaemonClient } from "@server/client/daemon-client";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { WorkspaceShortcutTargetsSubscriber } from "./workspace-shortcut-targets-subscriber";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

function workspaceDescriptor(input: {
  id: string;
  name?: string;
  projectId?: string;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: "Project 1",
    projectRootPath: "/repo/main",
    workspaceDirectory: `/repo/main/${input.id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.name ?? input.id,
    status: "done",
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("WorkspaceShortcutTargetsSubscriber", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    useKeyboardShortcutsStore.setState({
      sidebarShortcutWorkspaceTargets: [],
    });
    useSidebarCollapsedSectionsStore.setState({
      collapsedProjectKeys: new Set(),
    });
    useSidebarOrderStore.setState({
      projectOrderByServerId: {},
      workspaceOrderByServerAndProject: {},
    });

    act(() => {
      useSessionStore.getState().initializeSession("srv", null as unknown as DaemonClient);
      useSessionStore.getState().setWorkspaces(
        "srv",
        new Map([
          ["ws-1", workspaceDescriptor({ id: "ws-1", name: "Workspace 1" })],
          ["ws-2", workspaceDescriptor({ id: "ws-2", name: "Workspace 2" })],
        ]),
      );
      useSessionStore.getState().setHasHydratedWorkspaces("srv", true);
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
    act(() => {
      useSessionStore.getState().clearSession("srv");
    });
  });

  it("publishes workspace shortcut targets without rendering the sidebar", async () => {
    await act(async () => {
      root?.render(<WorkspaceShortcutTargetsSubscriber enabled={true} serverId="srv" />);
    });

    expect(useKeyboardShortcutsStore.getState().sidebarShortcutWorkspaceTargets).toEqual([
      { serverId: "srv", workspaceId: "ws-1" },
      { serverId: "srv", workspaceId: "ws-2" },
    ]);
  });

  it("clears targets when disabled", async () => {
    await act(async () => {
      root?.render(<WorkspaceShortcutTargetsSubscriber enabled={true} serverId="srv" />);
    });

    await act(async () => {
      root?.render(<WorkspaceShortcutTargetsSubscriber enabled={false} serverId="srv" />);
    });

    expect(useKeyboardShortcutsStore.getState().sidebarShortcutWorkspaceTargets).toEqual([]);
  });
});
