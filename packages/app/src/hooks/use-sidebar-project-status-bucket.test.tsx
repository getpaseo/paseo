/**
 * @vitest-environment jsdom
 */
import { act } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  useSidebarProjectStatusBucket,
  type SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

const SERVER_ID = "project-status-host";

function workspace(id: string, status: WorkspaceDescriptor["status"]): WorkspaceDescriptor {
  return {
    id,
    projectId: "project-a",
    projectDisplayName: "Project A",
    projectRootPath: "/repo/project-a",
    workspaceDirectory: `/repo/project-a/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    status,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function placement(workspaceId: string): SidebarWorkspacePlacement {
  return {
    workspaceKey: `${SERVER_ID}:${workspaceId}`,
    serverId: SERVER_ID,
    workspaceId,
    projectKey: "project-a",
    projectName: "Project A",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
  };
}

const PLACEMENTS: SidebarWorkspacePlacement[] = [placement("ws-1"), placement("ws-2")];

function setWorkspaces(workspaces: WorkspaceDescriptor[]): void {
  useSessionStore
    .getState()
    .setWorkspaces(SERVER_ID, new Map(workspaces.map((entry) => [entry.id, entry])));
}

interface Observed {
  bucket: SidebarStateBucket | null;
  renders: number;
}

function Probe({ observed, enabled }: { observed: Observed; enabled: boolean }): null {
  observed.bucket = useSidebarProjectStatusBucket({ workspaces: PLACEMENTS, enabled });
  observed.renders += 1;
  return null;
}

describe("useSidebarProjectStatusBucket", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
      setWorkspaces([workspace("ws-1", "done"), workspace("ws-2", "done")]);
      useSessionStore.getState().setHasHydratedWorkspaces(SERVER_ID, true);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(observed: Observed, enabled: boolean): void {
    act(() => {
      root.render(<Probe observed={observed} enabled={enabled} />);
    });
  }

  it("reports done while every workspace in the project is done", () => {
    const observed: Observed = { bucket: "running", renders: 0 };
    render(observed, true);
    expect(observed.bucket).toBe("done");
  });

  it("picks up a workspace that starts running after the row mounted", () => {
    const observed: Observed = { bucket: null, renders: 0 };
    render(observed, true);
    expect(observed.bucket).toBe("done");

    act(() => {
      setWorkspaces([workspace("ws-1", "done"), workspace("ws-2", "running")]);
    });

    expect(observed.bucket).toBe("running");
  });

  it("escalates to the more urgent bucket when a second workspace needs input", () => {
    const observed: Observed = { bucket: null, renders: 0 };
    render(observed, true);

    act(() => {
      setWorkspaces([workspace("ws-1", "running"), workspace("ws-2", "done")]);
    });
    expect(observed.bucket).toBe("running");

    act(() => {
      setWorkspaces([workspace("ws-1", "running"), workspace("ws-2", "needs_input")]);
    });
    expect(observed.bucket).toBe("needs_input");
  });

  it("returns to done once the work finishes", () => {
    const observed: Observed = { bucket: null, renders: 0 };
    render(observed, true);

    act(() => {
      setWorkspaces([workspace("ws-1", "running"), workspace("ws-2", "done")]);
    });
    expect(observed.bucket).toBe("running");

    act(() => {
      setWorkspaces([workspace("ws-1", "done"), workspace("ws-2", "done")]);
    });
    expect(observed.bucket).toBe("done");
  });

  it("does not re-render when a status change leaves the aggregate unchanged", () => {
    const observed: Observed = { bucket: null, renders: 0 };
    render(observed, true);

    act(() => {
      setWorkspaces([workspace("ws-1", "running"), workspace("ws-2", "done")]);
    });
    const rendersAfterFirstChange = observed.renders;

    // ws-2 also starts running: two running workspaces still aggregate to "running".
    act(() => {
      setWorkspaces([workspace("ws-1", "running"), workspace("ws-2", "running")]);
    });

    expect(observed.bucket).toBe("running");
    expect(observed.renders).toBe(rendersAfterFirstChange);
  });

  it("stays null and ignores status churn while the project is expanded", () => {
    const observed: Observed = { bucket: "done", renders: 0 };
    render(observed, false);
    expect(observed.bucket).toBeNull();
    const rendersAfterMount = observed.renders;

    act(() => {
      setWorkspaces([workspace("ws-1", "needs_input"), workspace("ws-2", "running")]);
    });

    expect(observed.bucket).toBeNull();
    expect(observed.renders).toBe(rendersAfterMount);
  });
});
