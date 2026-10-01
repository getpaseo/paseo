import { describe, expect, it } from "vitest";
import type { UsagePreferences } from "./preferences";
import {
  choosePinnedUsageLayout,
  resolvePinnedUsage,
  type PinnedUsageSource,
  type PinnedUsageWindow,
} from "./pinned";
import type { UsageReportEntry, UsageWindow } from "./types";

function report(input: {
  sourceId: string;
  sourceLabel: string;
  account?: string;
  icon?: string;
  windows: UsageWindow[];
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:${input.account ?? "default"}`,
    account: input.account ? { label: input.account } : {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    ...(input.icon ? { icon: input.icon } : {}),
    report: { status: "available", windows: input.windows },
  };
}

const claude = report({
  sourceId: "claude",
  sourceLabel: "Claude",
  icon: "<svg/>",
  windows: [
    { id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 31 },
    { id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 80 },
  ],
});
const codex = report({
  sourceId: "codex",
  sourceLabel: "Codex",
  windows: [{ id: "weekly", label: "Weekly", remainingPct: 88 }],
});

function windows(reports: UsageReportEntry[], prefs: UsagePreferences): PinnedUsageWindow[] {
  return resolvePinnedUsage(reports, prefs).flatMap((source) => source.windows);
}

function preferences(
  pinned: UsagePreferences["pinned"],
  displayAs: UsagePreferences["displayAs"] = "used",
): UsagePreferences {
  return { displayAs, pinned, serverId: null };
}

describe("choosePinnedUsageLayout", () => {
  const widths = { labelsWidth: 200, percentsWidth: 120, windowCount: 2 };

  it("shows meters only when every window's meter fits beside the labels", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: 240 })).toBe("meters");
    expect(choosePinnedUsageLayout({ ...widths, available: 239 })).toBe("labels");
  });

  it("drops the labels before it lets the line overflow", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: 199 })).toBe("percents");
  });

  it("shows labels until the widths are measured", () => {
    expect(choosePinnedUsageLayout({ ...widths, available: null })).toBe("labels");
    expect(choosePinnedUsageLayout({ ...widths, available: 999, labelsWidth: null })).toBe(
      "labels",
    );
  });
});

describe("resolvePinnedUsage", () => {
  it("defaults to the first window with a percent for each source account", () => {
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [
        { id: "empty", label: "Empty" },
        { id: "weekly", label: "Weekly", usedPct: 90 },
      ],
    });
    const empty = report({
      sourceId: "empty",
      sourceLabel: "Empty",
      windows: [{ id: "empty", label: "Empty" }],
    });
    expect(
      windows([claude, codex, work, empty], preferences([])).map((item) => [
        item.key,
        item.percentText,
      ]),
    ).toEqual([
      ["claude:default/five-hour", "31%"],
      ["claude:work/weekly", "90%"],
      ["codex:default/weekly", "12%"],
    ]);
  });

  it("pins replace defaults, and removing all pins restores defaults", () => {
    const reports = [claude, codex];
    expect(
      windows(reports, preferences([{ sourceId: "claude", windowId: "weekly" }])).map(
        (item) => item.key,
      ),
    ).toEqual(["claude:default/weekly"]);
    expect(windows(reports, preferences([])).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "codex:default/weekly",
    ]);
  });

  it("groups pinned windows by source in report order, not pin order", () => {
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 90 }],
    });
    const sources = resolvePinnedUsage(
      [claude, codex, work],
      preferences([
        { sourceId: "claude", windowId: "weekly" },
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "claude", windowId: "five-hour" },
      ]),
    );

    const windowKeys = (source: PinnedUsageSource) => source.windows.map((window) => window.key);
    expect(sources.map((source) => [source.key, windowKeys(source)])).toEqual([
      ["claude:default", ["claude:default/five-hour", "claude:default/weekly"]],
      ["claude:work", ["claude:work/weekly"]],
      ["codex:default", ["codex:default/weekly"]],
    ]);
    expect(sources[0]).toEqual({
      key: "claude:default",
      icon: "<svg/>",
      windows: [
        {
          key: "claude:default/five-hour",
          label: "Claude Session 31% used",
          shortLabel: "5h",
          percent: 31,
          percentText: "31%",
          tone: "default",
        },
        {
          key: "claude:default/weekly",
          label: "Claude Weekly 80% used",
          shortLabel: "wk",
          percent: 80,
          percentText: "80%",
          tone: "warning",
        },
      ],
    });
  });

  it("names a window by its label when the source gives no short label", () => {
    const items = windows([codex], preferences([{ sourceId: "codex", windowId: "weekly" }]));

    expect(items.map((item) => item.shortLabel)).toEqual(["Weekly"]);
  });

  it("defaults to every window the source marks as summary, when it marks any", () => {
    const marked = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      windows: [
        { id: "five-hour", label: "Session", shortLabel: "5h", usedPct: 31, summary: true },
        { id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 80, summary: true },
        { id: "weekly-fable", label: "Weekly · Fable", usedPct: 8 },
      ],
    });

    expect(windows([marked, codex], preferences([])).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "claude:default/weekly",
      "codex:default/weekly",
    ]);
  });

  it("keeps an empty short label empty, for a percent that needs no name", () => {
    const opencode = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode Go",
      windows: [{ id: "rolling", label: "Rolling", shortLabel: "", usedPct: 21 }],
    });
    const items = windows([opencode], preferences([]));

    expect(items.map((item) => item.shortLabel)).toEqual([""]);
  });

  it("formats the share left when the user reads usage as remaining", () => {
    const items = windows(
      [claude, codex],
      preferences(
        [
          { sourceId: "claude", windowId: "five-hour" },
          { sourceId: "codex", windowId: "weekly" },
        ],
        "remaining",
      ),
    );

    expect(items.map((item) => item.percentText)).toEqual(["69%", "88%"]);
    expect(items.map((item) => item.label)).toEqual([
      "Claude Session 69% left",
      "Codex Weekly 88% left",
    ]);
  });

  it("leaves out a pinned window that no report has, or that reports no percent", () => {
    const noPercent = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode",
      windows: [{ id: "monthly", label: "Monthly" }],
    });
    const items = windows(
      [claude, noPercent],
      preferences([
        { sourceId: "claude", windowId: "monthly" },
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "opencode", windowId: "monthly" },
      ]),
    );

    expect(items).toEqual([]);
  });

  it("shows a pin once per account of the source", () => {
    const personal = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "personal",
      windows: [{ id: "five-hour", label: "5-hour", usedPct: 10 }],
    });
    const work = report({
      sourceId: "claude",
      sourceLabel: "Claude",
      account: "work",
      windows: [{ id: "five-hour", label: "5-hour", usedPct: 90 }],
    });
    const items = windows(
      [personal, codex, work],
      preferences([{ sourceId: "claude", windowId: "five-hour" }]),
    );

    expect(items.map((item) => [item.label, item.percentText])).toEqual([
      ["Claude (personal) 5-hour 10% used", "10%"],
      ["Claude (work) 5-hour 90% used", "90%"],
    ]);
  });
});
