import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity, resolveWorkspaceRouteId } from "./workspace-identity";

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
    statusEnteredAt: null,
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
