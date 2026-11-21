import { describe, expect, it } from "vitest";
import {
  childTimesByParent,
  effectiveSortTime,
  orderSidebarSubagentRows,
  orderWorkspaceKeys,
  reuseEqualMap,
  sameAgentSortClock,
  sameWorkspaceSortClock,
  sidebarSubagentSortTime,
  type AgentSortClock,
  type WorkspaceSortClock,
} from "./nested-sort";

const nested = new Set(["s:child"]);
const parents = new Map([["s:child", ["s:parent"]]]);

describe("orderWorkspaceKeys", () => {
  const times = new Map([
    ["s:parent", 10],
    ["s:other", 20],
    ["s:child", 30],
  ]);
  const timeOf = (key: string) => times.get(key) ?? 0;
  const childTimes = childTimesByParent(parents, timeOf);

  it("keeps a list that hides nothing and inherits no child time", () => {
    const keys = ["s:other", "s:parent"];
    expect(orderWorkspaceKeys(keys, nested, "lastPrompt", timeOf, new Map())).toBe(keys);
    expect(orderWorkspaceKeys(keys, nested, undefined, timeOf, childTimes)).toBe(keys);
  });

  it("lifts a parent when its nested workspace is in another project", () => {
    expect(
      orderWorkspaceKeys(["s:other", "s:parent"], nested, "lastPrompt", timeOf, childTimes),
    ).toEqual(["s:parent", "s:other"]);
    expect(
      orderWorkspaceKeys(["s:other", "s:parent"], nested, "created", timeOf, childTimes),
    ).toEqual(["s:parent", "s:other"]);
  });

  it("keeps the list when an inherited child time does not change order", () => {
    const keys = ["s:parent", "s:other"];
    expect(orderWorkspaceKeys(keys, nested, "lastPrompt", timeOf, childTimes)).toBe(keys);
  });

  it("does not re-sort manual order when a child lives in another project", () => {
    const keys = ["s:other", "s:parent"];
    expect(orderWorkspaceKeys(keys, nested, "manual", timeOf, childTimes)).toBe(keys);
  });

  it("drops hidden keys and leaves an inactive sort alone", () => {
    expect(
      orderWorkspaceKeys(["s:child", "s:parent", "s:other"], nested, undefined, timeOf, childTimes),
    ).toEqual(["s:parent", "s:other"]);
  });

  it("drops nested keys and leaves manual order alone", () => {
    expect(
      orderWorkspaceKeys(["s:child", "s:other", "s:parent"], nested, "manual", timeOf, childTimes),
    ).toEqual(["s:other", "s:parent"]);
  });

  it("sorts a parent by its newest nested workspace", () => {
    expect(
      orderWorkspaceKeys(
        ["s:other", "s:parent", "s:child"],
        nested,
        "lastPrompt",
        timeOf,
        childTimes,
      ),
    ).toEqual(["s:parent", "s:other"]);
  });

  it("does not let a nested workspace move a row it is not listed under", () => {
    expect(effectiveSortTime("s:other", timeOf, childTimes)).toBe(20);
    expect(effectiveSortTime("s:parent", timeOf, childTimes)).toBe(30);
  });

  it("ignores a nested workspace with no clock", () => {
    const missing = childTimesByParent(parents, () => null);
    expect(
      orderWorkspaceKeys(["s:other", "s:parent", "s:child"], nested, "created", timeOf, missing),
    ).toEqual(["s:other", "s:parent"]);
  });
});

describe("orderSidebarSubagentRows", () => {
  const older = { id: "older", createdAt: 1 };
  const newer = { id: "newer", createdAt: 2 };

  it("keeps the track order for manual sort", () => {
    const rows = [older, newer];
    expect(orderSidebarSubagentRows(rows, "manual", (row) => row.createdAt)).toBe(rows);
  });

  it("lists the newest first and breaks ties by id", () => {
    expect(orderSidebarSubagentRows([older, newer], "created", (row) => row.createdAt)).toEqual([
      newer,
      older,
    ]);
    const tied = [
      { id: "b", createdAt: 1 },
      { id: "a", createdAt: 1 },
    ];
    expect(orderSidebarSubagentRows(tied, "lastPrompt", () => 1).map((row) => row.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("sidebarSubagentSortTime", () => {
  const agents = new Map<string, AgentSortClock>([
    ["s:child", { createdAt: 5, lastPromptAt: 15, workspaceKey: "s:review" }],
    ["s:shared", { createdAt: 4, lastPromptAt: 8, workspaceKey: "s:main" }],
  ]);
  const workspaces = new Map<string, WorkspaceSortClock>([
    ["s:review", { createdAt: 50, lastPromptAt: 70, statusEnteredAt: 70 }],
    ["s:main", { createdAt: 1, lastPromptAt: 100, statusEnteredAt: null }],
  ]);

  it("uses a nested workspace's clock and a shared agent's own prompt", () => {
    expect(
      sidebarSubagentSortTime({
        row: { id: "child", kind: "paseo", createdAt: new Date(5), address: { serverId: "s" } },
        sort: "lastPrompt",
        listingWorkspaceKey: "s:main",
        agents,
        workspaces,
      }),
    ).toBe(70);
    expect(
      sidebarSubagentSortTime({
        row: { id: "shared", kind: "paseo", createdAt: new Date(4), address: { serverId: "s" } },
        sort: "lastPrompt",
        listingWorkspaceKey: "s:main",
        agents,
        workspaces,
      }),
    ).toBe(8);
  });

  it("sorts a provider subagent by when it was created", () => {
    expect(
      sidebarSubagentSortTime({
        row: { id: "probe", kind: "provider", createdAt: new Date(9) },
        sort: "lastPrompt",
        listingWorkspaceKey: "s:main",
        agents,
        workspaces,
      }),
    ).toBe(9);
  });
});

describe("reuseEqualMap", () => {
  const clock: WorkspaceSortClock = { createdAt: 1, lastPromptAt: 2, statusEnteredAt: null };

  it("keeps the previous workspace clocks when every value matches", () => {
    const previous = new Map([["s:a", clock]]);
    const next = new Map<string, WorkspaceSortClock>([["s:a", { ...clock }]]);
    expect(reuseEqualMap(previous, next, sameWorkspaceSortClock)).toBe(previous);
  });

  it("replaces workspace clocks when a time changes", () => {
    const previous = new Map([["s:a", clock]]);
    const next = new Map<string, WorkspaceSortClock>([["s:a", { ...clock, lastPromptAt: 9 }]]);
    expect(reuseEqualMap(previous, next, sameWorkspaceSortClock)).toBe(next);
    const statusChanged = new Map<string, WorkspaceSortClock>([
      ["s:a", { ...clock, statusEnteredAt: 4 }],
    ]);
    expect(reuseEqualMap(previous, statusChanged, sameWorkspaceSortClock)).toBe(statusChanged);
  });

  it("keeps agent clocks until the workspace key or a time changes", () => {
    const previous = new Map<string, AgentSortClock>([
      ["s:a", { createdAt: 1, lastPromptAt: 2, workspaceKey: "s:w" }],
    ]);
    const next = new Map<string, AgentSortClock>([
      ["s:a", { createdAt: 1, lastPromptAt: 2, workspaceKey: "s:w" }],
    ]);
    expect(reuseEqualMap(previous, next, sameAgentSortClock)).toBe(previous);
    const moved = new Map<string, AgentSortClock>([
      ["s:a", { createdAt: 1, lastPromptAt: 2, workspaceKey: "s:other" }],
    ]);
    expect(reuseEqualMap(previous, moved, sameAgentSortClock)).toBe(moved);
  });
});
