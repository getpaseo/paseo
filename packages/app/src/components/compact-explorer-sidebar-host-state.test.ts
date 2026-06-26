import { describe, expect, it } from "vitest";
import {
  resolveCompactExplorerSidebarHostModel,
  type CompactExplorerSidebarHostModel,
} from "@/components/compact-explorer-sidebar-host-state";
import type { WorkspaceDescriptor } from "@/stores/session-store";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project 1",
    projectRootPath: input.projectRootPath ?? "/repo",
    workspaceDirectory: input.workspaceDirectory ?? "/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "done",
    archivingAt: input.archivingAt ?? null,
    statusEnteredAt: null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

function createModel(
  overrides: Partial<CompactExplorerSidebarHostModel> = {},
): CompactExplorerSidebarHostModel {
  return {
    serverId: overrides.serverId ?? "server-1",
    workspaceId: overrides.workspaceId ?? "workspace-a",
    persistenceKey: overrides.persistenceKey ?? "server-1:workspace-a",
    workspaceRoot: overrides.workspaceRoot ?? "/repo/a",
    isGit: overrides.isGit ?? true,
  };
}

describe("resolveCompactExplorerSidebarHostModel", () => {
  it("retains the last workspace root for the same active selection while the workspace reloads", () => {
    const previous = createModel();

    const result = resolveCompactExplorerSidebarHostModel({
      previous,
      selection: { serverId: "server-1", workspaceId: "workspace-a" },
      workspace: null,
      isGit: false,
    });

    expect(result).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
      persistenceKey: "server-1:workspace-a",
      workspaceRoot: "/repo/a",
      isGit: true,
    });
  });

  it("switches ownership to the active workspace instead of leaking the previous one", () => {
    const previous = createModel();

    const result = resolveCompactExplorerSidebarHostModel({
      previous,
      selection: { serverId: "server-1", workspaceId: "workspace-b" },
      workspace: null,
      isGit: false,
    });

    expect(result).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-b",
      persistenceKey: "server-1:workspace-b",
      workspaceRoot: "",
      isGit: false,
    });
  });

  it("does not retain a previous owner when there is no active workspace selection", () => {
    const result = resolveCompactExplorerSidebarHostModel({
      previous: createModel(),
      selection: null,
      workspace: null,
      isGit: false,
    });

    expect(result).toBeNull();
  });

  it("uses the current workspace directory when it is available", () => {
    const result = resolveCompactExplorerSidebarHostModel({
      previous: null,
      selection: { serverId: "server-1", workspaceId: "workspace-a" },
      workspace: createWorkspace({ id: "workspace-a", workspaceDirectory: "/repo/current" }),
      isGit: true,
    });

    expect(result).toEqual({
      serverId: "server-1",
      workspaceId: "workspace-a",
      persistenceKey: "server-1:workspace-a",
      workspaceRoot: "/repo/current",
      isGit: true,
    });
  });
});
