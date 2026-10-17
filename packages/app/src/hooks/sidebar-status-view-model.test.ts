import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";
import {
  buildStatusGroups,
  buildStatusShortcutIndex,
  getStatusBucketLabel,
  STATUS_BUCKET_ORDER,
  type StatusGroup,
} from "./sidebar-status-view-model";

function ws(
  input: Partial<SidebarWorkspaceEntry> & { workspaceKey: string },
): SidebarWorkspaceEntry {
  return {
    serverId: input.serverId ?? "srv",
    workspaceId: input.workspaceId ?? input.workspaceKey.split(":")[1] ?? "ws",
    projectViewKey: input.projectViewKey ?? "proj",
    projectName: input.projectName ?? "Project",
    projectRootPath: input.projectRootPath,
    workspaceDirectory: input.workspaceDirectory ?? "",
    workspaceDirectoryLabel: input.workspaceDirectoryLabel ?? "",
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "worktree",
    name: input.name ?? "main",
    title: input.title ?? null,
    currentBranch: input.currentBranch ?? null,
    statusBucket: input.statusBucket ?? "done",
    statusEnteredAt: input.statusEnteredAt ?? null,
    lastStartedAt: input.lastStartedAt ?? null,
    hasRunningAgent: input.hasRunningAgent ?? false,
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
  it("keeps status buckets fixed while names, starts, and running priority only order their rows", () => {
    const rows = [
      ws({
        workspaceKey: "srv:older",
        name: "Workspace 10",
        lastStartedAt: new Date(10),
        hasRunningAgent: true,
        statusBucket: "attention",
      }),
      ws({
        workspaceKey: "srv:latest",
        name: "Workspace 2",
        lastStartedAt: new Date(20),
        statusBucket: "attention",
      }),
      ws({
        workspaceKey: "srv:urgent",
        name: "Z",
        lastStartedAt: new Date(1),
        statusBucket: "needs_input",
      }),
      ws({
        workspaceKey: "srv:done",
        name: "A",
        lastStartedAt: new Date(30),
        statusBucket: "done",
      }),
    ];
    const groups = (sortMode: "manual" | "name" | "recent", runningFirst = false) =>
      buildStatusGroups({
        workspaces: rows,
        projectNamesByViewKey: emptyProjectNames,
        t: i18n.t,
        sortMode,
        runningFirst,
      });
    for (const mode of ["manual", "name", "recent"] as const) {
      expect(groups(mode).map((g) => g.bucket)).toEqual(["needs_input", "attention", "done"]);
    }
    expect(groups("name")[1].rows.map((w) => w.name)).toEqual(["Workspace 2", "Workspace 10"]);
    expect(groups("recent")[1].rows.map((w) => w.workspaceKey)).toEqual([
      "srv:latest",
      "srv:older",
    ]);
    expect(groups("recent", true)[1].rows.map((w) => w.workspaceKey)).toEqual([
      "srv:older",
      "srv:latest",
    ]);
    rows[0].hasRunningAgent = false;
    rows[0].statusEnteredAt = new Date(9999);
    expect(groups("recent", true)[1].rows.map((w) => w.workspaceKey)).toEqual([
      "srv:latest",
      "srv:older",
    ]);
    expect(groups("recent")[1].rows.map((w) => w.workspaceKey)).toEqual([
      "srv:latest",
      "srv:older",
    ]);
  });

  it("sorts by the last start when selected, even if status has not changed", () => {
    const workspaces = [
      ws({
        workspaceKey: "srv:first",
        statusEnteredAt: d("2026-10-14T12:00:00Z"),
        lastStartedAt: d("2026-10-14T10:00:00Z"),
      }),
      ws({
        workspaceKey: "srv:second",
        statusEnteredAt: d("2026-10-14T10:00:00Z"),
        lastStartedAt: d("2026-10-14T13:00:00Z"),
      }),
    ];
    expect(
      buildStatusGroups({
        workspaces: workspaces,
        projectNamesByViewKey: emptyProjectNames,
        t: i18n.t,
        sortMode: "recent",
      })[0].rows.map((row) => row.workspaceKey),
    ).toEqual(["srv:second", "srv:first"]);
    expect(
      buildStatusGroups({
        workspaces: workspaces,
        projectNamesByViewKey: emptyProjectNames,
        t: i18n.t,
      })[0].rows.map((row) => row.workspaceKey),
    ).toEqual(["srv:first", "srv:second"]);
  });
  it("preserves default status ordering for manual and sorts names inside fixed buckets", () => {
    const rows = [
      ws({ workspaceKey: "srv:z", name: "Workspace 10", statusEnteredAt: new Date(10) }),
      ws({ workspaceKey: "srv:a", name: "Workspace 2", statusEnteredAt: new Date(20) }),
    ];
    expect(
      buildStatusGroups({
        workspaces: rows,
        projectNamesByViewKey: emptyProjectNames,
        t: i18n.t,
        sortMode: "manual",
      })[0].rows.map((w) => w.name),
    ).toEqual(["Workspace 2", "Workspace 10"]);
    expect(
      buildStatusGroups({
        workspaces: rows,
        projectNamesByViewKey: emptyProjectNames,
        t: i18n.t,
        sortMode: "name",
      })[0].rows.map((w) => w.name),
    ).toEqual(["Workspace 2", "Workspace 10"]);
  });
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

    const groups = buildStatusGroups({
      workspaces: workspaces,
      projectNamesByViewKey: emptyProjectNames,
      t: i18n.t,
    });

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

    const groups = buildStatusGroups({
      workspaces: workspaces,
      projectNamesByViewKey: emptyProjectNames,
      t: i18n.t,
    });

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

    const groups = buildStatusGroups({
      workspaces: workspaces,
      projectNamesByViewKey: emptyProjectNames,
      t: i18n.t,
    });

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

    const groups = buildStatusGroups({
      workspaces: workspaces,
      projectNamesByViewKey: emptyProjectNames,
      t: i18n.t,
    });

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
      ws({
        workspaceKey: "srv:1",
        statusBucket: "done",
        projectViewKey: "proj-b",
        name: "zebra",
      }),
      ws({
        workspaceKey: "srv:2",
        statusBucket: "done",
        projectViewKey: "proj-a",
        name: "alpha",
      }),
      ws({
        workspaceKey: "srv:3",
        statusBucket: "done",
        projectViewKey: "proj-a",
        name: "alpha",
      }),
    ];

    const groups = buildStatusGroups({
      workspaces: workspaces,
      projectNamesByViewKey: projectNames,
      t: i18n.t,
    });

    expect(groups[0]?.rows.map((r) => r.workspaceKey)).toEqual(["srv:2", "srv:3", "srv:1"]);
  });

  it("returns empty array for no workspaces", () => {
    const groups = buildStatusGroups({
      workspaces: [],
      projectNamesByViewKey: emptyProjectNames,
      t: i18n.t,
    });
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

    const groups = buildStatusGroups({
      workspaces: workspaces,
      projectNamesByViewKey: emptyProjectNames,
      t: i18n.t,
    });

    expect(groups.map((g) => g.bucket)).toEqual(STATUS_BUCKET_ORDER);
    expect(groups.map((g) => g.label)).toEqual(
      STATUS_BUCKET_ORDER.map((b) => getStatusBucketLabel(b, i18n.t)),
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

describe("getStatusBucketLabel", () => {
  it("reads in the active app language", async () => {
    await i18n.changeLanguage("fr");
    try {
      expect(STATUS_BUCKET_ORDER.map((bucket) => getStatusBucketLabel(bucket, i18n.t))).toEqual([
        "Attend une réponse",
        "Échec",
        "À relire",
        "En cours",
        "Terminé",
      ]);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
