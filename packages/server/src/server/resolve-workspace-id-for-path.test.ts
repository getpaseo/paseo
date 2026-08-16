import { homedir } from "node:os";
import { basename } from "node:path";
import { describe, expect, test } from "vitest";

import { createPersistedWorkspaceRecord } from "./workspace-registry.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";

function createWorkspaceRecord(
  cwd: string,
  workspaceId: string,
  overrides?: { createdAt?: string; archivedAt?: string },
) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd,
    kind: "directory",
    displayName: basename(cwd) || cwd,
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides?.archivedAt ?? null,
  });
}

// resolveWorkspaceIdForPath is the external path→workspace adapter for
// archive-by-path. It is NOT ownership: a record's owner is its workspaceId.
// The per-id status law is exercised in workspace-directory.test.ts.

describe("resolveWorkspaceIdForPath", () => {
  test("fails closed when multiple workspaces share the exact compatibility cwd", () => {
    expect(
      resolveWorkspaceIdForPath("/workspace/project", [
        createWorkspaceRecord("/workspace/project", "ws-1"),
        createWorkspaceRecord("/workspace/project", "ws-2"),
        createWorkspaceRecord("/workspace/other", "ws-3"),
      ]),
    ).toBeNull();
  });

  test("uses only an explicit host-visible path for a selected workspace", () => {
    const selected = createWorkspaceRecord("/workspace", "docker-workspace");
    selected.runtime = { runtimeId: "docker" };
    selected.hostVisiblePath = null;
    expect(resolveWorkspaceIdForPath("/workspace", [selected])).toBeNull();

    selected.hostVisiblePath = "/host/worktrees/selected";
    expect(resolveWorkspaceIdForPath("/host/worktrees/selected", [selected])).toBe(
      "docker-workspace",
    );
  });

  test("resolves an exact archived workspace match for archive-by-path", () => {
    expect(
      resolveWorkspaceIdForPath("/workspace/project", [
        createWorkspaceRecord("/workspace/project", "ws-archived", {
          archivedAt: "2026-03-05T00:00:00.000Z",
        }),
      ]),
    ).toEqual("ws-archived");
  });

  test("resolves the deepest enclosing workspace for a subdirectory path", () => {
    expect(
      resolveWorkspaceIdForPath("/workspace/project/packages/app", [
        createWorkspaceRecord("/workspace/project", "ws-1"),
        createWorkspaceRecord("/workspace", "ws-root"),
      ]),
    ).toEqual("ws-1");
  });

  test("does not match the home directory as a prefix", () => {
    const home = homedir();

    expect(
      resolveWorkspaceIdForPath(`${home}/child`, [createWorkspaceRecord(home, "ws-home")]),
    ).toBeNull();
    expect(resolveWorkspaceIdForPath(home, [createWorkspaceRecord(home, "ws-home")])).toEqual(
      "ws-home",
    );
  });
});
