// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { seedSessionWorkspaces } from "@/test/seed-session";
import { useWorkspaceHasDiffStat } from "./workspace-diff-stat";

const SERVER_ID = "diff-stat-pill";
const WORKSPACE_ID = "workspace";

const workspace: WorkspaceDescriptor = {
  id: WORKSPACE_ID,
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo",
  projectKind: "git",
  workspaceKind: "local_checkout",
  name: "main",
  status: "done",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
  scripts: [],
};

function setDiffStat(diffStat: WorkspaceDescriptor["diffStat"]): void {
  useSessionStore.getState().setWorkspaces(SERVER_ID, (workspaces) => {
    const next = new Map(workspaces);
    next.set(WORKSPACE_ID, { ...workspace, diffStat });
    return next;
  });
}

describe("useWorkspaceHasDiffStat", () => {
  beforeEach(() => {
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    seedSessionWorkspaces(SERVER_ID, new Map([[WORKSPACE_ID, workspace]]));
  });

  afterEach(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("does not re-render its owner when only the visible counts change", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useWorkspaceHasDiffStat(SERVER_ID, WORKSPACE_ID);
    });

    expect(result.current).toBe(false);
    expect(renderCount).toBe(1);

    act(() => setDiffStat({ additions: 2, deletions: 0 }));
    expect(result.current).toBe(true);
    expect(renderCount).toBe(2);

    act(() => setDiffStat({ additions: 5, deletions: 3 }));
    expect(result.current).toBe(true);
    expect(renderCount).toBe(2);

    act(() => setDiffStat(null));
    expect(result.current).toBe(false);
    expect(renderCount).toBe(3);
  });
});
