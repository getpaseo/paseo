import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { buildDayGroups, type DayGroup } from "./sidebar-day-view-model";
import type { SidebarWorkspaceEntry } from "./use-sidebar-workspaces-list";

const t = ((key: string) => key) as unknown as TFunction;
const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed "now": 2026-10-15 15:00 local, so late-yesterday activity cannot leak into today.
const NOW = new Date(2026, 9, 15, 15, 0, 0);

function entry(key: string, lastStartedAt: Date | null): SidebarWorkspaceEntry {
  return {
    workspaceKey: key,
    lastStartedAt,
  } as SidebarWorkspaceEntry;
}

function keys(groups: readonly DayGroup[]): string[] {
  return groups.map((group) => group.key);
}

function groupRowKeys(groups: readonly DayGroup[]): string[][] {
  return groups.map((group) => group.rows.map((row) => row.workspaceKey));
}

describe("buildDayGroups", () => {
  it("buckets today, yesterday, dated days, and older", () => {
    const groups = buildDayGroups({
      workspaces: [
        entry("now", new Date(NOW.getTime() - 60 * 1000)),
        entry("last-night", new Date(2026, 9, 14, 23, 30)),
        entry("five-days", new Date(2026, 9, 10, 12, 0)),
        entry("six-days", new Date(2026, 9, 9, 12, 0)),
        entry("old", new Date(2026, 8, 1, 12, 0)),
        entry("never", null),
      ],
      t,
      now: NOW,
    });

    expect(keys(groups)).toEqual([
      "today",
      "yesterday",
      `day-${new Date(2026, 9, 10).getTime()}`,
      `day-${new Date(2026, 9, 9).getTime()}`,
      "older",
    ]);
    const older = groups[groups.length - 1];
    expect(older.rows.map((row) => row.workspaceKey)).toEqual(["old", "never"]);
  });

  it("orders rows within a bucket by activity, newest first", () => {
    const groups = buildDayGroups({
      workspaces: [
        entry("a", new Date(NOW.getTime() - 3 * 60 * 60 * 1000)),
        entry("b", new Date(NOW.getTime() - 30 * 60 * 1000)),
      ],
      t,
      now: NOW,
    });
    expect(groups[0].rows.map((row) => row.workspaceKey)).toEqual(["b", "a"]);
  });

  it("skips empty buckets entirely", () => {
    const groups = buildDayGroups({
      workspaces: [
        entry("now", new Date(NOW.getTime() - 1000)),
        entry("old", new Date(2020, 0, 1)),
      ],
      t,
      now: NOW,
    });
    expect(keys(groups)).toEqual(["today", "older"]);
  });

  it("treats one second before local midnight as yesterday", () => {
    const groups = buildDayGroups({
      workspaces: [entry("edge", new Date(new Date(2026, 9, 15, 0, 0, 0).getTime() - 1000))],
      t,
      now: NOW,
    });
    expect(keys(groups)).toEqual(["yesterday"]);
  });

  it("caps the dated range at five days before falling through to Older", () => {
    const workspaces = Array.from({ length: 8 }, (_, index) =>
      entry(`d${index}`, new Date(NOW.getTime() - index * DAY_MS - 60 * 1000)),
    );
    const groups = buildDayGroups({ workspaces, t, now: NOW });
    // today, yesterday, 5 dated buckets, older — anything past six days back is Older.
    expect(groups).toHaveLength(8);
    expect(keys(groups).slice(-1)).toEqual(["older"]);
  });
  it.each([
    [2026, 2, 9],
    [2026, 10, 2],
    [2026, 2, 30],
    [2026, 9, 26],
    [2027, 0, 1],
  ])(
    "keeps local calendar boundaries across DST and year changes (%i-%i-%i)",
    (year, month, day) => {
      const today = new Date(year, month, day);
      const yesterday = new Date(year, month, day - 1);
      const dated = new Date(year, month, day - 2);
      const oldestDated = new Date(year, month, day - 6);
      const older = new Date(year, month, day - 7);
      const groups = buildDayGroups({
        workspaces: [
          entry("today-edge", today),
          entry("yesterday-edge", yesterday),
          entry("before-yesterday", new Date(yesterday.getTime() - 1)),
          entry("six-days", oldestDated),
          entry("seven-days", older),
        ],
        t,
        now: new Date(year, month, day, 12),
      });
      expect(keys(groups)).toEqual([
        "today",
        "yesterday",
        `day-${dated.getTime()}`,
        `day-${oldestDated.getTime()}`,
        "older",
      ]);
      expect(groupRowKeys(groups)).toEqual([
        ["today-edge"],
        ["yesterday-edge"],
        ["before-yesterday"],
        ["six-days"],
        ["seven-days"],
      ]);
    },
  );

  it("prioritizes running agents only inside their own day and keeps equal-time order", () => {
    const latest = entry("latest", new Date(2026, 9, 15, 14));
    const active = { ...entry("active", new Date(2026, 9, 15, 10)), hasRunningAgent: true };
    const olderActive = { ...entry("yesterday", new Date(2026, 9, 14, 20)), hasRunningAgent: true };
    const tied = entry("tied", latest.lastStartedAt ?? null);
    const workspaces = [latest, tied, active, olderActive];
    const before = workspaces.slice();
    const order = (runningFirst: boolean) =>
      groupRowKeys(buildDayGroups({ workspaces, runningFirst, t, now: NOW }));
    expect(order(true)).toEqual([["active", "latest", "tied"], ["yesterday"]]);
    active.hasRunningAgent = false;
    expect(order(true)).toEqual([["latest", "tied", "active"], ["yesterday"]]);
    expect(order(false)).toEqual([["latest", "tied", "active"], ["yesterday"]]);
    expect(workspaces).toEqual(before);
  });

  it("uses a stable dated collapse key as the date ages and rebuckets at midnight", () => {
    const workspaces = [
      entry("dated", new Date(2026, 9, 13, 10)),
      entry("today", new Date(2026, 9, 15, 10)),
    ];
    const first = buildDayGroups({ workspaces, t, now: new Date(2026, 9, 15, 23, 59, 59) });
    const next = buildDayGroups({ workspaces, t, now: new Date(2026, 9, 16, 0) });
    expect(keys(first)).toEqual(["today", `day-${new Date(2026, 9, 13).getTime()}`]);
    expect(keys(next)).toEqual(["yesterday", `day-${new Date(2026, 9, 13).getTime()}`]);
    expect(next[1].label).toBe(
      new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(
        new Date(2026, 9, 13),
      ),
    );
  });
});
