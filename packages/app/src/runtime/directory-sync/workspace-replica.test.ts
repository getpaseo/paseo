import { expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { WorkspaceDirectoryReplica } from "./workspace-replica";

function workspace(id: string, projectId = "project"): WorkspaceDescriptorPayload {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath: `/repo/${projectId}`,
    workspaceDirectory: `/repo/${projectId}/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title: id,
    status: "done",
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

it("commits workspace and project-parent state with filtered removals", () => {
  const serverId = "workspace-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const empty = normalizeProjectDescriptor({
    projectId: "empty",
    projectDisplayName: "Empty",
    projectRootPath: "/repo/empty",
    projectKind: "git",
  });
  replica.commitSnapshot(
    {
      workspaces: new Map([
        ["kept", normalizeWorkspaceDescriptor(workspace("kept"))],
        ["filtered", normalizeWorkspaceDescriptor(workspace("filtered", "filtered-project"))],
      ]),
      projects: new Map([[empty.projectId, empty]]),
    },
    [{ kind: "remove", id: "filtered", removedProjectId: "filtered-project" }],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["kept"]);
  expect(Array.from(session?.projects.keys() ?? [])).toEqual(["empty"]);
  store.clearSession(serverId);
});

it("commits the authoritative snapshot before buffered project updates", () => {
  const serverId = "project-update-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const attachedMain = normalizeWorkspaceDescriptor(workspace("attached-main", "attached"));
  const attachedFeature = normalizeWorkspaceDescriptor(workspace("attached-feature", "attached"));
  const removed = normalizeWorkspaceDescriptor(workspace("removed", "removed"));
  const unrelated = normalizeWorkspaceDescriptor(workspace("unrelated", "unrelated"));
  const staleAttachedProject = normalizeProjectDescriptor({
    projectId: "attached",
    projectDisplayName: "Stale attached project",
    projectRootPath: "/repo/attached",
    projectKind: "git",
  });
  const removedProject = normalizeProjectDescriptor({
    projectId: "removed",
    projectDisplayName: "Removed project",
    projectRootPath: "/repo/removed",
    projectKind: "git",
  });
  const unchangedEmptyProject = normalizeProjectDescriptor({
    projectId: "unchanged-empty",
    projectDisplayName: "Unchanged empty project",
    projectRootPath: "/repo/unchanged-empty",
    projectKind: "git",
  });

  replica.commitSnapshot(
    {
      workspaces: new Map([
        [attachedMain.id, attachedMain],
        [attachedFeature.id, attachedFeature],
        [removed.id, removed],
        [unrelated.id, unrelated],
      ]),
      projects: new Map([
        [staleAttachedProject.projectId, staleAttachedProject],
        [removedProject.projectId, removedProject],
        [unchangedEmptyProject.projectId, unchangedEmptyProject],
      ]),
    },
    [
      {
        kind: "upsert",
        project: {
          projectId: "attached",
          projectKey: "remote:github.com/acme/attached",
          projectDisplayName: "Renamed attached project",
          projectCustomName: "Personal name",
          projectRootPath: "/moved/attached",
          projectKind: "directory",
        },
      },
      {
        kind: "upsert",
        project: {
          projectId: "new-empty",
          projectDisplayName: "New empty project",
          projectRootPath: "/repo/new-empty",
          projectKind: "directory",
        },
      },
      { kind: "remove", projectId: "removed" },
    ],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(session?.workspaces.get(attachedMain.id)).toMatchObject({
    projectDisplayName: "Renamed attached project",
    projectCustomName: "Personal name",
    projectRootPath: "/moved/attached",
    projectKind: "directory",
  });
  expect(session?.workspaces.get(attachedFeature.id)).toMatchObject({
    projectDisplayName: "Renamed attached project",
    projectRootPath: "/moved/attached",
  });
  expect(session?.workspaces.has(removed.id)).toBe(false);
  expect(session?.workspaces.get(unrelated.id)).toBe(unrelated);
  expect(Array.from(session?.projects.keys() ?? [])).toEqual([
    "attached",
    "unchanged-empty",
    "new-empty",
  ]);
  expect(session?.projects.get("unchanged-empty")).toBe(unchangedEmptyProject);
  expect(session?.projects.get("new-empty")).toMatchObject({
    projectDisplayName: "New empty project",
    projectRootPath: "/repo/new-empty",
  });
  store.clearSession(serverId);
});

it("does not invent a null-key project from a workspace update", () => {
  const serverId = "workspace-before-project-update";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);

  replica.applyDelta({ kind: "upsert", workspace: workspace("main", "fresh-project") });

  const session = useSessionStore.getState().sessions[serverId];
  expect(session?.workspaces.has("main")).toBe(true);
  expect(session?.projects.has("fresh-project")).toBe(false);
  store.clearSession(serverId);
});
