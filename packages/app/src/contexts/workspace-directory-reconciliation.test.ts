import { expect, it } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { reconcileWorkspaceDirectory } from "./workspace-directory-reconciliation";

function workspace(id: string, title: string): WorkspaceDescriptorPayload {
  return {
    id,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title,
    status: "done",
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

it("keeps workspace upserts and removals received during later pages", () => {
  const result = reconcileWorkspaceDirectory({
    snapshot: new Map([
      ["updated", normalizeWorkspaceDescriptor(workspace("updated", "snapshot"))],
      ["removed", normalizeWorkspaceDescriptor(workspace("removed", "snapshot"))],
    ]),
    deltas: [
      { kind: "upsert", workspace: workspace("updated", "live") },
      { kind: "remove", id: "removed" },
    ],
  });

  expect(Array.from(result.values()).map(({ id, title }) => [id, title])).toEqual([
    ["updated", "live"],
  ]);
});
