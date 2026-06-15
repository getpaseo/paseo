import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";
import {
  buildStatusGroups,
  buildStatusShortcutIndex,
  STATUS_BUCKET_LABELS,
  STATUS_BUCKET_ORDER,
  type StatusGroup,
} from "./sidebar-status-view-model";

function ws(
  input: Partial<SidebarWorkspaceEntry> & { workspaceKey: string },
): SidebarWorkspaceEntry {
  return {
    serverId: input.serverId ?? "srv",
    workspaceId: input.workspaceId ?? input.workspaceKey.split(":")[1] ?? "ws",
    projectKey: input.projectKey ?? "proj",
    projectRootPath: input.projectRootPath,
    workspaceDirectory: input.workspaceDirectory,
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "worktree",
    name: input.name ?? "main",
    title: input.title ?? null,
    currentBranch: input.currentBranch ?? null,
    statusBucket: input.statusBucket ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    workspaceKey: input.workspaceKey,
  };
}

function d(iso: string): Date {
  return new Date(iso);
}

const emptyProjectNames = new Map<string, string>();

describe("buildStatusGroups", () => {
  it("groups workspaces by status bucket in fixed order", () => {
    const workspaces = [
      ws({ workspaceKey: "srv:done-ws", statusBucket: "done", name: "done-ws" }),
      ws({
        workspaceKey: "srv:needs-input-ws",
        statusBucket: "needs_input",
        name: "needs-input-ws",
      }),
      ws({ workspaceKey: "srv:running-ws", statusBucket: "running", name: "running-ws" }),
    ];

    const groups = buildStatusGroups(workspaces, emptyProjectNames);

    expect(groups.map((g) => g.bucket)).toEqual(["needs_input", "running", "done"]);
    expect(groups[0]?.label).toBe("Needs input");
    expect(groups[1]?.label).toBe("Working");
    expect(groups[2]?.label).toBe("Done");
  });

  it("omits empty buckets", () => {
    const workspaces = [
      ws({ workspaceKey: "srv:a", statusBucket: "done" }),
      ws({ workspaceKey: "srv:b", statusBucket: "running" }),
    ];

    const groups = buildStatusGroups(workspaces, emptyProjectNames);

    expect(groups.map((g) => g.bucket)).toEqual(["running", "done"]);
  });

  it("sorts by statusEnteredAt desc within a bucket", () => {
    const workspaces = [
      ws({
        workspaceKey: "srv:old",
        statusBucket: "done",
        statusEnteredAt: d("2026-01-01T00:00:00Z"),
      }),
      ws({
        workspaceKey: "srv:new",
        statusBucket: "done",
        statusEnteredAt: d("2026-06-01T00:00:00Z"),
      }),
      ws({
        workspaceKey: "srv:mid",
        statusBucket: "done",
        statusEnteredAt: d("2026-03-01T00:00:00Z"),
      }),
    ];

    const groups = buildStatusGroups(workspaces, emptyProjectNames);

    expect(groups[0]?.rows.map((r) => r.workspaceKey)).toEqual(["srv:new", "srv:mid", "srv:old"]);
  });

  it("sorts null timestamps last within a bucket", () => {
    const workspaces = [
      ws({ workspaceKey: "srv:null-a", statusBucket: "done", statusEnteredAt: null }),
      ws({
        workspaceKey: "srv:ts",
        statusBucket: "done",
        statusEnteredAt: d("2026-01-01T00:00:00Z"),
      }),
      ws({ workspaceKey: "srv:null-b", statusBucket: "done", statusEnteredAt: null }),
    ];

    const groups = buildStatusGroups(workspaces, emptyProjectNames);

    expect(groups[0]?.rows.map((r) => r.workspaceKey)).toEqual([
      "srv:ts",
      "srv:null-a",
      "srv:null-b",
    ]);
  });

  it("tie-breaks by project name, then workspace name, then workspaceKey", () => {
    const projectNames = new Map<string, string>([
      ["proj-b", "Beta"],
      ["proj-a", "Alpha"],
    ]);

    const workspaces = [
      ws({ workspaceKey: "srv:1", statusBucket: "done", projectKey: "proj-b", name: "zebra" }),
      ws({ workspaceKey: "srv:2", statusBucket: "done", projectKey: "proj-a", name: "alpha" }),
      ws({ workspaceKey: "srv:3", statusBucket: "done", projectKey: "proj-a", name: "alpha" }),
    ];

    const groups = buildStatusGroups(workspaces, projectNames);

    expect(groups[0]?.rows.map((r) => r.workspaceKey)).toEqual(["srv:2", "srv:3", "srv:1"]);
  });

  it("returns empty array for no workspaces", () => {
    const groups = buildStatusGroups([], emptyProjectNames);
    expect(groups).toEqual([]);
  });

  it("uses hydrated workspace entries with real status, not structural placeholders", () => {
    const workspaces = [
      ws({
        workspaceKey: "srv:ni",
        statusBucket: "needs_input",
        statusEnteredAt: d("2026-01-01T00:00:00Z"),
      }),
      ws({
        workspaceKey: "srv:fail",
        statusBucket: "failed",
        statusEnteredAt: d("2026-01-01T00:00:00Z"),
      }),
      ws({
        workspaceKey: "srv:att",
        statusBucket: "attention",
        statusEnteredAt: d("2026-01-01T00:00:00Z"),
      }),
      ws({
        workspaceKey: "srv:run",
        statusBucket: "running",
        statusEnteredAt: d("2026-01-01T00:00:00Z"),
      }),
      ws({ workspaceKey: "srv:dn", statusBucket: "done", statusEnteredAt: null }),
    ];

    const groups = buildStatusGroups(workspaces, emptyProjectNames);

    expect(groups.map((g) => g.bucket)).toEqual(STATUS_BUCKET_ORDER);
    expect(groups.map((g) => g.label)).toEqual(
      STATUS_BUCKET_ORDER.map((b) => STATUS_BUCKET_LABELS[b]),
    );
    // Each group has exactly one row with the matching bucket
    for (const group of groups) {
      expect(group.rows).toHaveLength(1);
      expect(group.rows[0]?.statusBucket).toBe(group.bucket);
    }
  });
});

describe("buildStatusShortcutIndex", () => {
  it("assigns sequential numbers in status visual order", () => {
    const groups: StatusGroup[] = [
      { bucket: "needs_input", label: "Needs input", rows: [ws({ workspaceKey: "srv:ni" })] },
      {
        bucket: "running",
        label: "Working",
        rows: [ws({ workspaceKey: "srv:run" }), ws({ workspaceKey: "srv:run2" })],
      },
      { bucket: "done", label: "Done", rows: [ws({ workspaceKey: "srv:dn" })] },
    ];

    const index = buildStatusShortcutIndex(groups);

    expect(index.get("srv:ni")).toBe(1);
    expect(index.get("srv:run")).toBe(2);
    expect(index.get("srv:run2")).toBe(3);
    expect(index.get("srv:dn")).toBe(4);
  });

  it("stops at 9 shortcuts", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ws({ workspaceKey: `srv:ws${i}` }));
    const groups: StatusGroup[] = [{ bucket: "done", label: "Done", rows }];

    const index = buildStatusShortcutIndex(groups);

    expect(index.size).toBe(9);
    expect(index.has("srv:ws8")).toBe(true);
    expect(index.has("srv:ws9")).toBe(false);
  });

  it("returns empty map for empty groups", () => {
    const index = buildStatusShortcutIndex([]);
    expect(index.size).toBe(0);
  });
});
