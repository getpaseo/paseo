import { expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  normalizeEmptyProjectDescriptor,
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
  const empty = normalizeEmptyProjectDescriptor({
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
      emptyProjects: new Map([[empty.projectId, empty]]),
    },
    [{ kind: "remove", id: "filtered", removedProjectId: "filtered-project" }],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["kept"]);
  expect(Array.from(session?.emptyProjects.keys() ?? [])).toEqual(["empty"]);
  store.clearSession(serverId);
});
