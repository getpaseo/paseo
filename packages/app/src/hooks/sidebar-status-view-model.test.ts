import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "./sidebar-workspaces-view-model";
import {
  buildStatusGroups,
  buildStatusShortcutIndex,
  resolveRecencyTickMs,
  STATUS_GROUP_LABELS,
  STATUS_GROUP_ORDER,
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

    expect(groups.map((g) => g.key)).toEqual(["needs_input", "running", "done"]);
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

    expect(groups.map((g) => g.key)).toEqual(["running", "done"]);
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

    // "recently_done" only materializes with a recency window, so the real
    // status buckets are what this fixture can produce.
    const statusBuckets = STATUS_GROUP_ORDER.filter((key) => key !== "recently_done");
    expect(groups.map((g) => g.key)).toEqual(statusBuckets);
    expect(groups.map((g) => g.label)).toEqual(
      statusBuckets.map((key) => STATUS_GROUP_LABELS[key]),
    );
    // Each group has exactly one row with the matching bucket
    for (const group of groups) {
      expect(group.rows).toHaveLength(1);
      expect(group.rows[0]?.statusBucket).toBe(group.key);
    }
  });
});

describe("buildStatusGroups recently-done window", () => {
  const NOW = d("2026-01-01T12:00:00Z").getTime();
  const MINUTE = 60_000;

  function doneAt(workspaceKey: string, minutesAgo: number): SidebarWorkspaceEntry {
    return ws({
      workspaceKey,
      statusBucket: "done",
      statusEnteredAt: new Date(NOW - minutesAgo * MINUTE),
    });
  }

  it("splits fresh finishes above Done and leaves older ones behind", () => {
    const groups = buildStatusGroups(
      [doneAt("srv:old", 20), doneAt("srv:fresh", 2)],
      emptyProjectNames,
      {
        windowMs: 5 * MINUTE,
        clientNow: NOW,
        serverClockOffsetMsByServerId: new Map([["srv", 0]]),
      },
    );

    expect(groups.map((g) => g.key)).toEqual(["recently_done", "done"]);
    expect(groups[0]?.label).toBe("Recently done");
    expect(groups[0]?.rows.map((r) => r.workspaceKey)).toEqual(["srv:fresh"]);
    expect(groups[1]?.rows.map((r) => r.workspaceKey)).toEqual(["srv:old"]);
  });

  it("keeps Done whole when the window is zero or absent", () => {
    const workspaces = [doneAt("srv:fresh", 1)];

    expect(buildStatusGroups(workspaces, emptyProjectNames).map((g) => g.key)).toEqual(["done"]);
    expect(
      buildStatusGroups(workspaces, emptyProjectNames, {
        windowMs: 0,
        clientNow: NOW,
        serverClockOffsetMsByServerId: new Map([["srv", 0]]),
      }).map((g) => g.key),
    ).toEqual(["done"]);
  });

  it("only splits Done, and never a workspace with no transition time", () => {
    const groups = buildStatusGroups(
      [
        ws({ workspaceKey: "srv:no-ts", statusBucket: "done", statusEnteredAt: null }),
        ws({
          workspaceKey: "srv:run",
          statusBucket: "running",
          statusEnteredAt: new Date(NOW - MINUTE),
        }),
      ],
      emptyProjectNames,
      {
        windowMs: 5 * MINUTE,
        clientNow: NOW,
        serverClockOffsetMsByServerId: new Map([["srv", 0]]),
      },
    );

    expect(groups.map((g) => g.key)).toEqual(["running", "done"]);
  });

  it("uses each host clock instead of comparing daemon timestamps to the client clock", () => {
    const serverOffsetMs = 3 * 60 * MINUTE;
    const workspace = ws({
      workspaceKey: "srv:fresh",
      statusBucket: "done",
      statusEnteredAt: new Date(NOW + serverOffsetMs - 2 * MINUTE),
    });
    const groups = buildStatusGroups([workspace], emptyProjectNames, {
      windowMs: 5 * MINUTE,
      clientNow: NOW,
      serverClockOffsetMsByServerId: new Map([["srv", serverOffsetMs]]),
    });

    expect(groups.map((g) => g.key)).toEqual(["recently_done"]);
  });

  it("keeps an uncalibrated or future-timestamp workspace in Done", () => {
    const future = doneAt("srv:future", -10);
    const uncalibrated = buildStatusGroups([future], emptyProjectNames, {
      windowMs: 5 * MINUTE,
      clientNow: NOW,
      serverClockOffsetMsByServerId: new Map(),
    });
    const calibrated = buildStatusGroups([future], emptyProjectNames, {
      windowMs: 5 * MINUTE,
      clientNow: NOW,
      serverClockOffsetMsByServerId: new Map([["srv", 0]]),
    });

    expect(uncalibrated.map((g) => g.key)).toEqual(["done"]);
    expect(calibrated.map((g) => g.key)).toEqual(["done"]);
  });
});

describe("resolveRecencyTickMs", () => {
  const MINUTE = 60_000;

  it("schedules no tick when the window is off", () => {
    expect(resolveRecencyTickMs(0)).toBeNull();
    expect(resolveRecencyTickMs(-1)).toBeNull();
  });

  it("floors at 5s so a short window still ages out promptly", () => {
    expect(resolveRecencyTickMs(MINUTE)).toBe(15_000);
    expect(resolveRecencyTickMs(10_000)).toBe(5_000);
  });

  it("caps at 60s so a long window doesn't poll a quarter-hour apart", () => {
    expect(resolveRecencyTickMs(5 * MINUTE)).toBe(60_000);
    expect(resolveRecencyTickMs(60 * MINUTE)).toBe(60_000);
  });
});

describe("buildStatusShortcutIndex", () => {
  it("assigns sequential numbers in status visual order", () => {
    const groups: StatusGroup[] = [
      { key: "needs_input", label: "Needs input", rows: [ws({ workspaceKey: "srv:ni" })] },
      {
        key: "running",
        label: "Working",
        rows: [ws({ workspaceKey: "srv:run" }), ws({ workspaceKey: "srv:run2" })],
      },
      { key: "done", label: "Done", rows: [ws({ workspaceKey: "srv:dn" })] },
    ];

    const index = buildStatusShortcutIndex(groups);

    expect(index.get("srv:ni")).toBe(1);
    expect(index.get("srv:run")).toBe(2);
    expect(index.get("srv:run2")).toBe(3);
    expect(index.get("srv:dn")).toBe(4);
  });

  it("stops at 9 shortcuts", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ws({ workspaceKey: `srv:ws${i}` }));
    const groups: StatusGroup[] = [{ key: "done", label: "Done", rows }];

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
