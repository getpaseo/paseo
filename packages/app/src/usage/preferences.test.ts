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
    const pinned = toggleUsagePin(
      toggleUsagePin(DEFAULT_USAGE_PREFERENCES, codexWeekly),
      claudeFiveHour,
    );

    expect(pinned.pinned).toEqual([codexWeekly, claudeFiveHour]);
    expect(isUsagePinned(pinned, { sourceId: "codex", windowId: "weekly" })).toBe(true);
    expect(isUsagePinned(pinned, { sourceId: "codex", windowId: "five-hour" })).toBe(false);
  });

  it("unpins a pinned window and keeps the others in order", () => {
    const three = [codexWeekly, claudeFiveHour, { sourceId: "claude", windowId: "weekly" }];
    const unpinned = toggleUsagePin(
      { displayAs: "used", pinned: three, serverId: null },
      claudeFiveHour,
    );

    expect(unpinned.pinned).toEqual([codexWeekly, { sourceId: "claude", windowId: "weekly" }]);
  });

  it("switches between used and remaining without touching pins", () => {
    const preferences = { displayAs: "used" as const, pinned: [codexWeekly], serverId: null };

    expect(setUsageDisplayAs(preferences, "remaining")).toEqual({
      displayAs: "remaining",
      pinned: [codexWeekly],
      serverId: null,
    });
  });

  it("remembers the picked host without touching pins", () => {
    expect(setUsageHost({ ...DEFAULT_USAGE_PREFERENCES, pinned: [codexWeekly] }, "server")).toEqual(
      { displayAs: "used", pinned: [codexWeekly], serverId: "server" },
    );
  });

  it("reads preferences saved before hosts could be picked as no pick", () => {
    expect(UsagePreferencesSchema.parse({ displayAs: "remaining", pinned: [codexWeekly] })).toEqual(
      { displayAs: "remaining", pinned: [codexWeekly], serverId: null },
    );
  });
});
