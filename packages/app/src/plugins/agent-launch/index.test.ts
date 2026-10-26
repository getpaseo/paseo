import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { seedSessionWorkspaces } from "@/test/seed-session";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { resolveExistingLaunchWorkspace } from "./index";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@/utils/client-id", () => ({ getOrCreateClientId: vi.fn(async () => "cid_test") }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace: vi.fn() }));

function workspace(
  id: string,
  projectId: string,
  archivingAt: string | null = null,
): WorkspaceDescriptor {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath: `/repos/${projectId}`,
    projectKind: "git",
    workspaceDirectory: `/repos/${projectId}/${id}`,
    workspaceKind: "directory",
    name: id,
    title: null,
    status: "done",
    statusEnteredAt: null,
    archivingAt,
    activityAt: null,
    diffStat: null,
    scripts: [],
    gitRuntime: {},
  } as unknown as WorkspaceDescriptor;
}

beforeEach(() => {
  useSessionStore.setState({ sessions: {} } as never);
  useSessionStore.getState().initializeSession("host-1", null as unknown as DaemonClient);
  seedSessionWorkspaces(
    "host-1",
    new Map([
      ["wks-a", workspace("wks-a", "project-1")],
      ["wks-archived", workspace("wks-archived", "project-1", "2026-09-11T00:00:00.000Z")],
      ["wks-other", workspace("wks-other", "project-2")],
    ]),
  );
});

describe("resolveExistingLaunchWorkspace", () => {
  it("uses a valid same-project default and ignores archived or foreign defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      resolveExistingLaunchWorkspace({
        serverId: "host-1",
        projectId: "project-1",
        defaultWorkspaceId: "wks-a",
      }),
    ).toBe("wks-a");
    expect(
      resolveExistingLaunchWorkspace({
        serverId: "host-1",
        projectId: "project-1",
        defaultWorkspaceId: "wks-other",
      }),
    ).toBe("wks-a");
    expect(
      resolveExistingLaunchWorkspace({
        serverId: "host-1",
        projectId: "project-1",
        defaultWorkspaceId: "wks-archived",
      }),
    ).toBe("wks-a");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("returns nothing when the project has no unarchived workspace or the host is unknown", () => {
    expect(
      resolveExistingLaunchWorkspace({ serverId: "host-1", projectId: "project-3" }),
    ).toBeUndefined();
    expect(
      resolveExistingLaunchWorkspace({ serverId: "host-missing", projectId: "project-1" }),
    ).toBeUndefined();
  });
});
