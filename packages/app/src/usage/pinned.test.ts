import { describe, expect, it } from "vitest";
import type { UsagePreferences } from "./preferences";
import { resolvePinnedUsage } from "./pinned";
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
    { id: "five-hour", label: "5-hour", usedPct: 31 },
    { id: "weekly", label: "Weekly", usedPct: 80 },
  ],
});
const codex = report({
  sourceId: "codex",
  sourceLabel: "Codex",
  windows: [{ id: "weekly", label: "Weekly", remainingPct: 88 }],
});

function preferences(
  pinned: UsagePreferences["pinned"],
  displayAs: UsagePreferences["displayAs"] = "used",
): UsagePreferences {
  return { displayAs, pinned, serverId: null };
}

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
      resolvePinnedUsage([claude, codex, work, empty], preferences([])).map((item) => [
        item.key,
        item.percentText,
      ]),
    ).toEqual([
      ["claude:default/five-hour", "31%"],
      ["codex:default/weekly", "12%"],
      ["claude:work/weekly", "90%"],
    ]);
  });

  it("pins replace defaults, and removing all pins restores defaults", () => {
    const reports = [claude, codex];
    expect(
      resolvePinnedUsage(reports, preferences([{ sourceId: "claude", windowId: "weekly" }])).map(
        (item) => item.key,
      ),
    ).toEqual(["claude:default/weekly"]);
    expect(resolvePinnedUsage(reports, preferences([])).map((item) => item.key)).toEqual([
      "claude:default/five-hour",
      "codex:default/weekly",
    ]);
  });

  it("shows pinned windows in pin order, not report order", () => {
    const items = resolvePinnedUsage(
      [claude, codex],
      preferences([
        { sourceId: "codex", windowId: "weekly" },
        { sourceId: "claude", windowId: "five-hour" },
      ]),
    );

    expect(items).toEqual([
      {
        key: "codex:default/weekly",
        icon: null,
        label: "Codex Weekly 12% used",
        percentText: "12%",
      },
      {
        key: "claude:default/five-hour",
        icon: "<svg/>",
        label: "Claude 5-hour 31% used",
        percentText: "31%",
      },
    ]);
  });

  it("formats the share left when the user reads usage as remaining", () => {
    const items = resolvePinnedUsage(
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
      "Claude 5-hour 69% left",
      "Codex Weekly 88% left",
    ]);
  });

  it("leaves out a pinned window that no report has, or that reports no percent", () => {
    const noPercent = report({
      sourceId: "opencode",
      sourceLabel: "OpenCode",
      windows: [{ id: "monthly", label: "Monthly" }],
    });
    const items = resolvePinnedUsage(
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
    const items = resolvePinnedUsage(
      [personal, codex, work],
      preferences([{ sourceId: "claude", windowId: "five-hour" }]),
    );

    expect(items.map((item) => [item.label, item.percentText])).toEqual([
      ["Claude (personal) 5-hour 10% used", "10%"],
      ["Claude (work) 5-hour 90% used", "90%"],
    ]);
  });
});
