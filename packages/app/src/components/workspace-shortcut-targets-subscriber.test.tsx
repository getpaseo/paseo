/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { WorkspaceShortcutTargetsSubscriber } from "./workspace-shortcut-targets-subscriber";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

function workspaceDescriptor(input: {
  id: string;
  name?: string;
  projectId?: string;
  projectDisplayName?: string;
  status?: WorkspaceDescriptor["status"];
  statusEnteredAt?: Date | null;
}): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectRootPath: "/repo/main",
    workspaceDirectory: `/repo/main/${input.id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: input.name ?? input.id,
    status: input.status ?? "done",
    archivingAt: null,
    statusEnteredAt: input.statusEnteredAt ?? null,
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
    useSidebarViewStore.setState({
      groupModeByServerId: {},
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

  it("publishes status-mode shortcut targets in visual status order", async () => {
    act(() => {
      useSidebarViewStore.getState().setGroupMode("srv", "status");
      useSessionStore.getState().setWorkspaces(
        "srv",
        new Map([
          [
            "ws-done",
            workspaceDescriptor({
              id: "ws-done",
              name: "Done",
              projectId: "project-1",
              projectDisplayName: "Project 1",
              status: "done",
              statusEnteredAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
          ],
          [
            "ws-running-old",
            workspaceDescriptor({
              id: "ws-running-old",
              name: "Running old",
              projectId: "project-2",
              projectDisplayName: "Project 2",
              status: "running",
              statusEnteredAt: new Date("2026-02-01T00:00:00.000Z"),
            }),
          ],
          [
            "ws-needs-input",
            workspaceDescriptor({
              id: "ws-needs-input",
              name: "Needs input",
              projectId: "project-1",
              projectDisplayName: "Project 1",
              status: "needs_input",
              statusEnteredAt: new Date("2026-01-15T00:00:00.000Z"),
            }),
          ],
          [
            "ws-running-new",
            workspaceDescriptor({
              id: "ws-running-new",
              name: "Running new",
              projectId: "project-2",
              projectDisplayName: "Project 2",
              status: "running",
              statusEnteredAt: new Date("2026-03-01T00:00:00.000Z"),
            }),
          ],
        ]),
      );
    });

    await act(async () => {
      root?.render(<WorkspaceShortcutTargetsSubscriber enabled={true} serverId="srv" />);
    });

    expect(useKeyboardShortcutsStore.getState().sidebarShortcutWorkspaceTargets).toEqual([
      { serverId: "srv", workspaceId: "ws-needs-input" },
      { serverId: "srv", workspaceId: "ws-running-new" },
      { serverId: "srv", workspaceId: "ws-running-old" },
      { serverId: "srv", workspaceId: "ws-done" },
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
