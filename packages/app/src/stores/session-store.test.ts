import { describe, expect, it } from "vitest";
import {
  mergeWorkspaceSnapshotWithExisting,
  normalizeWorkspaceDescriptor,
  type WorkspaceDescriptor,
} from "./session-store";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "remote:github.com/hubtool/hubcode",
    projectDisplayName: input.projectDisplayName ?? "hubtool/hubcode",
    projectRootPath: input.projectRootPath ?? "/tmp/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    workspaceDirectory: input.workspaceDirectory ?? input.projectRootPath ?? "/tmp/repo",
    name: input.name ?? "main",
    status: input.status ?? "done",
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

describe("mergeWorkspaceSnapshotWithExisting", () => {
  it("preserves the last known diff stat when a snapshot only has baseline null data", () => {
    const existing = createWorkspace({
      id: "/tmp/repo",
      diffStat: { additions: 4, deletions: 2 },
    });
    const incoming = createWorkspace({
      id: "/tmp/repo",
      diffStat: null,
    });

    expect(mergeWorkspaceSnapshotWithExisting({ incoming, existing })).toEqual({
      ...incoming,
      diffStat: { additions: 4, deletions: 2 },
    });
  });

  it("uses the incoming diff stat when the server provides a known value", () => {
    const existing = createWorkspace({
      id: "/tmp/repo",
      diffStat: { additions: 4, deletions: 2 },
    });
    const incoming = createWorkspace({
      id: "/tmp/repo",
      diffStat: { additions: 0, deletions: 0 },
    });

    expect(mergeWorkspaceSnapshotWithExisting({ incoming, existing })).toEqual(incoming);
  });
});

describe("normalizeWorkspaceDescriptor", () => {
  it("defaults missing archivingAt to null", () => {
    const payload = {
      id: "1",
      projectId: "1",
      projectDisplayName: "Project 1",
      projectRootPath: "/repo",
      workspaceDirectory: "/repo",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
      diffStat: null,
      scripts: [],
    } as unknown as Parameters<typeof normalizeWorkspaceDescriptor>[0];

    const workspace = normalizeWorkspaceDescriptor(payload);

    expect(workspace.archivingAt).toBeNull();
  });
});
