import { describe, expect, it } from "vitest";
import {
  mergeWorkspaceSnapshotWithExisting,
  type WorkspaceDescriptor,
} from "./session-store";

function createWorkspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "remote:github.com/getpaseo/paseo",
    projectDisplayName: input.projectDisplayName ?? "getpaseo/paseo",
    projectRootPath: input.projectRootPath ?? "/tmp/repo",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "local_checkout",
    name: input.name ?? "main",
    status: input.status ?? "done",
    activityAt: input.activityAt ?? null,
    diffStat: input.diffStat ?? null,
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
