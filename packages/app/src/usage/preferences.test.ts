import { describe, expect, it } from "vitest";
import {
  DEFAULT_USAGE_PREFERENCES,
  isUsagePinned,
  setUsageDisplayAs,
  setUsageHost,
  toggleUsagePin,
  UsagePreferencesSchema,
} from "./preferences";

const claudeFiveHour = { sourceId: "claude", windowId: "five-hour" };
const codexWeekly = { sourceId: "codex", windowId: "weekly" };

describe("usage preferences", () => {
  it("pins windows in the order the user pins them", () => {
    const pinned = toggleUsagePin({
      preferences: toggleUsagePin({
        preferences: DEFAULT_USAGE_PREFERENCES,
        pin: codexWeekly,
        reports: [],
      }),
      pin: claudeFiveHour,
      reports: [],
    });

    expect(pinned.pins).toEqual([codexWeekly, claudeFiveHour]);
    expect(isUsagePinned(pinned, { sourceId: "codex", windowId: "weekly" }, [])).toBe(true);
    expect(isUsagePinned(pinned, { sourceId: "codex", windowId: "five-hour" }, [])).toBe(false);
  });

  it("unpins a pinned window and keeps the others in order", () => {
    const three = [codexWeekly, claudeFiveHour, { sourceId: "claude", windowId: "weekly" }];
    const unpinned = toggleUsagePin({
      preferences: { displayAs: "used", pins: three, serverId: null },
      pin: claudeFiveHour,
      reports: [],
    });

    expect(unpinned.pins).toEqual([codexWeekly, { sourceId: "claude", windowId: "weekly" }]);
  });

  it("switches between used and remaining without touching pins", () => {
    const preferences = { displayAs: "used" as const, pins: [codexWeekly], serverId: null };

    expect(setUsageDisplayAs(preferences, "remaining")).toEqual({
      displayAs: "remaining",
      pins: [codexWeekly],
      serverId: null,
    });
  });

  it("remembers the picked host without touching pins", () => {
    expect(setUsageHost({ ...DEFAULT_USAGE_PREFERENCES, pins: [codexWeekly] }, "server")).toEqual({
      displayAs: "used",
      pins: [codexWeekly],
      serverId: "server",
    });
  });

  it("reads preferences saved before hosts could be picked as no pick", () => {
    expect(UsagePreferencesSchema.parse({ displayAs: "remaining", pinned: [codexWeekly] })).toEqual(
      { displayAs: "remaining", pins: [codexWeekly], serverId: null },
    );
  });
});

it("default sidebar windows are pinned on cards and the first toggle removes only that row", () => {
  const reports = [
    {
      id: "claude:default",
      sourceId: "claude",
      sourceLabel: "Claude",
      account: {},
      fetchedAt: "2026-10-02T00:00:00Z",
      report: {
        status: "available" as const,
        windows: [
          { id: "five_hour", label: "5-hour", summary: true, usedPct: 31 },
          { id: "weekly", label: "Weekly", summary: true, usedPct: 54 },
        ],
      },
    },
    {
      id: "codex:default",
      sourceId: "codex",
      sourceLabel: "Codex",
      account: {},
      fetchedAt: "2026-10-02T00:00:00Z",
      report: {
        status: "available" as const,
        windows: [{ id: "five_hour", label: "5-hour", summary: true, usedPct: 7 }],
      },
    },
  ];
  const pins = [
    { sourceId: "claude", windowId: "five_hour" },
    { sourceId: "claude", windowId: "weekly" },
    { sourceId: "codex", windowId: "five_hour" },
  ];
  for (const pin of pins) expect(isUsagePinned(DEFAULT_USAGE_PREFERENCES, pin, reports)).toBe(true);
  const changed = toggleUsagePin({
    preferences: DEFAULT_USAGE_PREFERENCES,
    pin: pins[1]!,
    reports,
  });
  expect(isUsagePinned(changed, pins[1]!, reports)).toBe(false);
  expect(isUsagePinned(changed, pins[0]!, reports)).toBe(true);
  expect(isUsagePinned(changed, pins[2]!, reports)).toBe(true);
  const empty = toggleUsagePin({
    preferences: toggleUsagePin({ preferences: changed, pin: pins[0]!, reports }),
    pin: pins[2]!,
    reports,
  });
  const restored = UsagePreferencesSchema.parse(JSON.parse(JSON.stringify(empty)));
  for (const pin of pins) expect(isUsagePinned(restored, pin, reports)).toBe(false);
});

it("reads old selections without losing display or host and preserves an explicit empty selection", () => {
  for (const [input, pins] of [
    [{ pinned: [] }, null],
    [{ pinned: [codexWeekly] }, [codexWeekly]],
    [{ pins: [], pinned: [codexWeekly] }, []],
    [{ pins: null, pinned: [codexWeekly] }, null],
    [{ pins: "bad", pinned: [codexWeekly] }, null],
  ] as const) {
    expect(
      UsagePreferencesSchema.parse({ displayAs: "remaining", serverId: "host", ...input }),
    ).toEqual({ displayAs: "remaining", serverId: "host", pins });
  }
});
