import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  getWorkspaceExecutionAuthority,
  requireWorkspaceExecutionAuthority,
  resolveWorkspaceMapKeyByIdentity,
  resolveWorkspaceIdByExecutionDirectory,
  resolveWorkspaceRouteId,
} from "./workspace-execution";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "checkout",
    name: input.name ?? "main",
    status: input.status ?? "running",
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

describe("resolveWorkspaceRouteId", () => {
  it("trims route workspace ids without path normalization", () => {
    expect(resolveWorkspaceRouteId({ routeWorkspaceId: "  C:\\tmp\\repo\\  " })).toBe(
      "C:\\tmp\\repo\\",
    );
  });

  it("returns null for empty values", () => {
    expect(resolveWorkspaceRouteId({ routeWorkspaceId: "   " })).toBeNull();
  });
});

describe("resolveWorkspaceIdByExecutionDirectory", () => {
  it("matches workspace directories", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-1",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo/.paseo/worktrees/feature",
      }),
    ];

    expect(
      resolveWorkspaceIdByExecutionDirectory({
        workspaces,
        workspaceDirectory: "/repo/.paseo/worktrees/feature",
      }),
    ).toBe("workspace-1");
  });

  it("does not match project root metadata", () => {
    const workspaces = [
      createWorkspace({
        id: "workspace-1",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo/.paseo/worktrees/feature",
      }),
    ];

    expect(
      resolveWorkspaceIdByExecutionDirectory({
        workspaces,
        workspaceDirectory: "/repo",
      }),
    ).toBeNull();
  });
});

describe("resolveWorkspaceMapKeyByIdentity", () => {
  it("returns the existing map key when the identity already matches a key", () => {
    const workspaces = new Map<string, WorkspaceDescriptor>([
      [
        "workspace-1",
        createWorkspace({
          id: "workspace-1",
          workspaceDirectory: "/repo/.paseo/worktrees/feature",
        }),
      ],
    ]);

    expect(
      resolveWorkspaceMapKeyByIdentity({
        workspaces,
        workspaceId: "workspace-1",
      }),
    ).toBe("workspace-1");
  });

  it("does not resolve workspace directories when an id is required", () => {
    const workspaces = new Map<string, WorkspaceDescriptor>([
      [
        "workspace-1",
        createWorkspace({
          id: "workspace-1",
          workspaceDirectory: "C:\\repo\\feature\\",
        }),
      ],
    ]);

    expect(
      resolveWorkspaceMapKeyByIdentity({
        workspaces,
        workspaceId: "C:/repo/feature",
      }),
    ).toBeNull();
  });
});

describe("workspace execution authority", () => {
  it("returns an explicit failure when workspace id is missing", () => {
    expect(
      getWorkspaceExecutionAuthority({
        workspaces: new Map(),
        workspaceId: null,
      }),
    ).toEqual({
      ok: false,
      reason: "workspace_id_missing",
      message: "Workspace id is required.",
    });
  });

  it("returns an explicit failure when workspace directory is missing", () => {
    const workspaces = new Map<string, WorkspaceDescriptor>([
      [
        "workspace-1",
        createWorkspace({
          id: "workspace-1",
          workspaceDirectory: "   ",
          projectRootPath: "/repo",
        }),
      ],
    ]);

    expect(
      getWorkspaceExecutionAuthority({
        workspaces,
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      ok: false,
      reason: "workspace_directory_missing",
      message: "Workspace directory is missing for workspace workspace-1",
    });
  });

  it("never falls back to project root metadata", () => {
    const workspaces = new Map<string, WorkspaceDescriptor>([
      [
        "workspace-1",
        createWorkspace({
          id: "workspace-1",
          projectRootPath: "/repo",
          workspaceDirectory: "/repo/.paseo/worktrees/feature",
        }),
      ],
    ]);

    expect(
      requireWorkspaceExecutionAuthority({
        workspaces,
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      workspaceDirectory: "/repo/.paseo/worktrees/feature",
      workspace: workspaces.get("workspace-1"),
    });
  });
});
