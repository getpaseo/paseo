import { describe, expect, it } from "vitest";
import {
  formatUsageFreshness,
  groupUsageByHost,
  replaceReport,
  headlineWindow,
  resolveUsagePill,
  resolveUsageRefresh,
  resolveUsageView,
  type UsageQueryState,
} from "./model";
import type { UsageReportEntry, UsageWindow } from "./types";

function entry(input: {
  windows?: UsageWindow[];
  planLabel?: string;
  icon?: string;
  sourceId?: string;
}): UsageReportEntry {
  return {
    id: `${input.sourceId ?? "fixture"}:account-1`,
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId ?? "fixture",
    sourceLabel: "Fixture source",
    ...(input.icon ? { icon: input.icon } : {}),
    report: {
      status: "available",
      ...(input.planLabel ? { planLabel: input.planLabel } : {}),
      windows: input.windows ?? [],
    },
  };
}

function ready(data: UsageReportEntry[]): UsageQueryState {
  return { data, error: null, isFetching: false };
}

describe("resolveUsagePill", () => {
  it("shows the source icon and the headline window percent", () => {
    const pill = resolveUsagePill({
      supportsUsage: true,
      entry: entry({
        icon: "<svg/>",
        windows: [
          { id: "session", label: "Session", usedPct: 12 },
          { id: "weekly", label: "Weekly", usedPct: 64.6, headline: true },
        ],
      }),
    });

    expect(pill).toEqual({ icon: "<svg/>", sourceLabel: "Fixture source", text: "65%" });
  });

  it("derives the headline percent from remaining percent", () => {
    const pill = resolveUsagePill({
      supportsUsage: true,
      entry: entry({
        windows: [{ id: "daily", label: "Daily", remainingPct: 30, headline: true }],
      }),
    });

    expect(pill?.text).toBe("70%");
  });

  it("shows the plan label when no window is the headline", () => {
    const pill = resolveUsagePill({
      supportsUsage: true,
      entry: entry({
        planLabel: "Pro",
        windows: [{ id: "session", label: "Session", usedPct: 40 }],
      }),
    });

    expect(pill).toEqual({ icon: null, sourceLabel: "Fixture source", text: "Pro" });
  });

  it("shows only the icon with neither a headline window nor a plan label", () => {
    const pill = resolveUsagePill({ supportsUsage: true, entry: entry({}) });

    expect(pill).toEqual({ icon: null, sourceLabel: "Fixture source", text: null });
  });

  it("is hidden when the agent has no usage report", () => {
    expect(resolveUsagePill({ supportsUsage: true, entry: null })).toBeNull();
  });

  it("is hidden on a host without usage sources, whatever data is cached", () => {
    const cached = entry({ windows: [{ id: "w", label: "W", usedPct: 5, headline: true }] });

    expect(resolveUsagePill({ supportsUsage: false, entry: cached })).toBeNull();
  });
});

describe("headlineWindow", () => {
  it("does not fall back to the first window", () => {
    expect(headlineWindow(entry({ windows: [{ id: "a", label: "A", usedPct: 1 }] }).report)).toBe(
      null,
    );
  });
});

describe("resolveUsageView", () => {
  it("asks for a host update when the host lacks usage sources", () => {
    expect(
      resolveUsageView({ isConnected: true, supportsUsage: false, query: ready([entry({})]) }),
    ).toEqual({ kind: "unavailable", message: "Update the host to see usage" });
  });

  it("asks for a connection before anything else", () => {
    expect(
      resolveUsageView({ isConnected: false, supportsUsage: false, query: undefined }),
    ).toEqual({ kind: "unavailable", message: "Connect to this host to see usage" });
  });

  it("moves from loading to ready to error", () => {
    const base = { isConnected: true, supportsUsage: true };
    expect(resolveUsageView({ ...base, query: undefined })).toEqual({ kind: "loading" });
    expect(
      resolveUsageView({ ...base, query: { data: [], error: null, isFetching: true } }),
    ).toEqual({ kind: "ready", reports: [], isRefreshing: true });
    expect(
      resolveUsageView({
        ...base,
        query: { data: undefined, error: new Error("boom"), isFetching: false },
      }),
    ).toEqual({ kind: "error", message: "boom" });
  });
});

describe("groupUsageByHost", () => {
  it("groups reports under each connected host in host order", () => {
    const first = entry({ sourceId: "one" });
    const second = entry({ sourceId: "two" });
    const groups = groupUsageByHost(
      [
        { serverId: "b", label: "Beta", isConnected: true, supportsUsage: true },
        { serverId: "offline", label: "Offline", isConnected: false, supportsUsage: true },
        { serverId: "a", label: "Alpha", isConnected: true, supportsUsage: true },
      ],
      new Map([
        ["a", ready([first])],
        ["b", ready([second, first])],
      ]),
    );

    expect(groups).toEqual([
      {
        serverId: "b",
        label: "Beta",
        view: { kind: "ready", reports: [second, first], isRefreshing: false },
      },
      {
        serverId: "a",
        label: "Alpha",
        view: { kind: "ready", reports: [first], isRefreshing: false },
      },
    ]);
  });

  it("shows the update message in an old host's group", () => {
    const groups = groupUsageByHost(
      [
        { serverId: "new", label: "New", isConnected: true, supportsUsage: true },
        { serverId: "old", label: "Old", isConnected: true, supportsUsage: false },
      ],
      new Map([["new", ready([])]]),
    );

    expect(groups.map((group) => [group.label, group.view])).toEqual([
      ["New", { kind: "ready", reports: [], isRefreshing: false }],
      ["Old", { kind: "unavailable", message: "Update the host to see usage" }],
    ]);
  });
});

describe("formatUsageFreshness", () => {
  it("says when the report was fetched", () => {
    expect(formatUsageFreshness("now")).toBe("Updated just now");
    expect(formatUsageFreshness("3m")).toBe("Updated 3m ago");
    expect(formatUsageFreshness("Jan 15")).toBe("Updated Jan 15");
  });
});

describe("resolveUsageRefresh", () => {
  it("is pending while a refresh runs, even after an earlier failure", () => {
    expect(resolveUsageRefresh({ isPending: true, error: new Error("boom") })).toBe("pending");
  });

  it("is failed after a refresh errors", () => {
    expect(resolveUsageRefresh({ isPending: false, error: new Error("boom") })).toBe("failed");
  });

  it("is idle before and after a successful refresh", () => {
    expect(resolveUsageRefresh({ isPending: false, error: null })).toBe("idle");
  });
});

describe("replaceReport", () => {
  const alpha = entry({ sourceId: "alpha", planLabel: "Old" });
  const beta = entry({ sourceId: "beta" });

  it("swaps only the refreshed report, in place", () => {
    const refreshed = entry({ sourceId: "alpha", planLabel: "New" });
    expect(replaceReport([alpha, beta], alpha.id, refreshed)).toEqual([refreshed, beta]);
  });

  it("drops a report the daemon no longer knows", () => {
    expect(replaceReport([alpha, beta], alpha.id, null)).toEqual([beta]);
  });
});
