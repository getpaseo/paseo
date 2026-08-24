import { expect, it } from "vitest";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "./session-workspace-upserts";
import { reconcileWorkspaceDirectory } from "./workspace-directory-reconciliation";

const SERVER_ID = "workspace-directory-reconciliation";

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
    serverId: SERVER_ID,
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

it("does not restore a locally archiving workspace from a buffered upsert", () => {
  markWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "archiving" });
  try {
    const result = reconcileWorkspaceDirectory({
      serverId: SERVER_ID,
      snapshot: new Map(),
      deltas: [{ kind: "upsert", workspace: workspace("archiving", "live") }],
    });

    expect(result.has("archiving")).toBe(false);
  } finally {
    clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "archiving" });
  }
});
