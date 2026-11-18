import { describe, expect, it } from "vitest";
import type { CommandCenterContribution } from "./contributions";
import type { CommandCenterFileResult, CommandCenterWorkspaceResult } from "./results";
import { COMMAND_CENTER_LIST_METRICS } from "./list-metrics";
import { projectCommandCenterRows } from "./results";
import { buildCommandCenterSections } from "./sections";
import type { CommandCenterTab } from "./tabs";
import { createWorkspaceRanker } from "./workspace-search";

function workspace(
  id: string,
  options: {
    daysAgo?: number;
    title?: string;
    archived?: boolean;
    background?: boolean;
    agentTitle?: string;
  } = {},
): CommandCenterWorkspaceResult {
  return {
    kind: "workspace",
    id: `workspace:server:${id}`,
    serverId: "server",
    workspaceId: id,
    title: options.title ?? id,
    subtitle: "project · main",
    project: { viewKey: "project", name: "project", iconDataUri: null },
    changeRequestNumber: null,
    activityAt: new Date(Date.UTC(2026, 9, 30) - (options.daysAgo ?? 0) * 86_400_000),
    agents: options.agentTitle
      ? [{ id: `${id}-agent`, title: options.agentTitle, provider: "mock" }]
      : [],
    matchedAgent: null,
    archived: options.archived ?? false,
    background: options.background ?? false,
    run: () => undefined,
    openAgent: () => undefined,
  };
}

function action(id: string, group: string, visibility: "always" | "query" = "always") {
  return {
    id,
    group,
    groupRank: group === "workspace" ? 0 : 1,
    rank: 0,
    keywords: [],
    visibility,
    run: () => undefined,
    presentation: { kind: "action", title: id, sectionTitle: group },
  } satisfies CommandCenterContribution;
}

const file: CommandCenterFileResult = {
  kind: "file",
  id: "file:src/index.ts",
  filePath: "src/index.ts",
  title: "index.ts",
  subtitle: "src",
  run: () => undefined,
};

const workspaces = [
  workspace("current", { daysAgo: 0 }),
  workspace("payments", { daysAgo: 1, title: "Payments refactor" }),
  // Started by automation; more recent than the workspaces below it.
  workspace("nightly", { daysAgo: 1.5, title: "Nightly triage", background: true }),
  workspace("onboarding", { daysAgo: 2, title: "Onboarding flow", agentTitle: "Add receipts" }),
  workspace("docs", { daysAgo: 3, title: "Docs site" }),
  workspace("search", { daysAgo: 4, title: "Search ranking" }),
];
const archived = [workspace("billing", { title: "Billing cleanup", archived: true })];
const contributions = [
  action("New agent", "workspace"),
  action("Settings", "actions"),
  action("Group by status", "actions", "query"),
];

function listed(
  tab: CommandCenterTab,
  query: string,
  options: { archivedMatchedByHost?: boolean; showBackground?: boolean } = {},
) {
  const sections = buildCommandCenterSections({
    tab,
    query,
    rankWorkspaces: createWorkspaceRanker(),
    workspaces,
    archivedWorkspaces: query ? archived : [],
    archivedMatchedByHost: options.archivedMatchedByHost ?? true,
    showBackground: options.showBackground ?? false,
    currentWorkspaceId: "workspace:server:current",
    contributions,
    files: [file],
    titles: { recentWorkspaces: "Recent workspaces", workspaces: "Workspaces", files: "Files" },
  });
  return projectCommandCenterRows(sections, COMMAND_CENTER_LIST_METRICS.desktop).rows.map((row) =>
    row.kind === "section" ? `# ${row.title ?? ""}` : row.key,
  );
}

describe("command center tabs", () => {
  it("All leads with the three most recent workspaces, then actions, before a query", () => {
    expect(listed("all", "")).toEqual([
      "# Recent workspaces",
      "workspace:server:payments",
      "workspace:server:onboarding",
      "workspace:server:docs",
      "# workspace",
      "New agent",
      "# actions",
      "Settings",
    ]);
  });

  it("lists background workspaces unqueried only as the sidebar does; a query finds them", () => {
    expect(listed("all", "")).not.toContain("workspace:server:nightly");
    expect(listed("all", "", { showBackground: true })).not.toContain("workspace:server:nightly");
    expect(listed("workspaces", "")).not.toContain("workspace:server:nightly");
    expect(listed("workspaces", "", { showBackground: true })).toContain(
      "workspace:server:nightly",
    );
    expect(listed("all", "nightly")).toContain("workspace:server:nightly");
    expect(listed("workspaces", "nightly")).toContain("workspace:server:nightly");
  });

  it("All ranks every kind of result for a query, archived workspaces after active ones", () => {
    expect(listed("all", "i")).toEqual(
      expect.arrayContaining(["Settings", "file:src/index.ts", "workspace:server:billing"]),
    );
    const rows = listed("all", "ing");
    const workspaceRows = rows.filter((row) => row.startsWith("workspace:"));
    expect(workspaceRows.at(-1)).toBe("workspace:server:billing");
    expect(rows).not.toContain("# Recent workspaces");
  });

  it("Workspaces lists every workspace, current included, most recent first", () => {
    expect(listed("workspaces", "")).toEqual([
      "# Workspaces",
      "workspace:server:current",
      "workspace:server:payments",
      "workspace:server:onboarding",
      "workspace:server:docs",
      "workspace:server:search",
    ]);
  });

  it("Workspaces finds a workspace through its agent and appends archived matches", () => {
    expect(listed("workspaces", "receipts")).toEqual([
      "# Workspaces",
      "workspace:server:onboarding",
      "workspace:server:billing",
    ]);
  });

  it("keeps archived rows the host did not match for this query only if they match it", () => {
    // The previous query's archived results stand in while the next search loads.
    expect(listed("workspaces", "receipts", { archivedMatchedByHost: false })).toEqual([
      "# Workspaces",
      "workspace:server:onboarding",
    ]);
    expect(listed("workspaces", "billing", { archivedMatchedByHost: false })).toEqual([
      "# Workspaces",
      "workspace:server:billing",
    ]);
  });

  it("Files lists only files", () => {
    expect(listed("files", "")).toEqual(["# Files", "file:src/index.ts"]);
  });

  it("Actions lists every action, including those that otherwise wait for a query", () => {
    expect(listed("actions", "")).toEqual([
      "# workspace",
      "New agent",
      "# actions",
      "Settings",
      "Group by status",
    ]);
  });
});
