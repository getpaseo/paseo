import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  buildHistorySections,
  buildHistoryServerQuery,
  dedupeAndSortHistoryAgents,
  filterHistoryAgents,
  historyUpdatedAfter,
} from "./history-view-model";

const NOW = new Date("2026-07-13T12:00:00.000Z");

function agent(input: {
  id: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  pinnedAt?: string | null;
  projectKey?: string;
  projectName?: string;
  serverId?: string;
}): AggregatedAgent {
  return {
    id: input.id,
    serverId: input.serverId ?? "server-a",
    serverLabel: input.serverId ?? "Server A",
    title: input.title,
    lastActivityAt: new Date(input.updatedAt),
    createdAt: new Date(input.createdAt ?? input.updatedAt),
    pinnedAt: input.pinnedAt ? new Date(input.pinnedAt) : null,
    projectPlacement: input.projectKey
      ? ({
          projectKey: input.projectKey,
          projectName: input.projectName ?? input.projectKey,
        } as AggregatedAgent["projectPlacement"])
      : null,
  } as AggregatedAgent;
}

describe("history view model", () => {
  it("normalizes the server filter and uses pinned plus the selected sort", () => {
    expect(
      buildHistoryServerQuery({
        status: "archived",
        projectFilters: [" project-b ", "project-a", "project-a"],
        lastActivity: "7d",
        sortMode: "alphabetical",
        now: NOW,
      }),
    ).toEqual({
      filter: {
        archiveState: "archived",
        includeArchived: true,
        projectKeys: ["project-a", "project-b"],
        updatedAfter: new Date(2026, 6, 7).toISOString(),
      },
      sort: [
        { key: "pinned", direction: "desc" },
        { key: "title", direction: "asc" },
      ],
    });
  });

  it("uses local calendar-day bounds that remain stable during a day", () => {
    const morning = new Date(2026, 6, 13, 8, 0, 0);
    const evening = new Date(2026, 6, 13, 22, 30, 0);

    expect(historyUpdatedAfter("30d", morning)).toBe(historyUpdatedAfter("30d", evening));
    expect(historyUpdatedAfter("any", morning)).toBeUndefined();
  });

  it("globally orders pins first and applies the selected sort within both partitions", () => {
    const agents = [
      agent({ id: "z-regular", title: "Zulu", updatedAt: "2026-07-13T10:00:00Z" }),
      agent({
        id: "z-pinned",
        title: "Zulu pinned",
        updatedAt: "2026-07-10T10:00:00Z",
        pinnedAt: "2026-07-13T11:00:00Z",
      }),
      agent({ id: "a-regular", title: "Alpha", updatedAt: "2026-07-12T10:00:00Z" }),
      agent({
        id: "a-pinned",
        title: "Alpha pinned",
        updatedAt: "2026-07-09T10:00:00Z",
        pinnedAt: "2026-07-13T10:00:00Z",
      }),
    ];

    expect(dedupeAndSortHistoryAgents(agents, "alphabetical").map((item) => item.id)).toEqual([
      "a-pinned",
      "z-pinned",
      "a-regular",
      "z-regular",
    ]);
  });

  it("deduplicates repeated agents across paginated results", () => {
    const older = agent({ id: "same", title: "Old", updatedAt: "2026-07-10T10:00:00Z" });
    const newer = agent({ id: "same", title: "New", updatedAt: "2026-07-12T10:00:00Z" });

    expect(dedupeAndSortHistoryAgents([older, newer], "recency")).toEqual([newer]);
  });

  it("reapplies archived-only, project, and date filters for legacy hosts", () => {
    const matching = agent({
      id: "matching",
      title: "Matching",
      updatedAt: "2026-07-12T10:00:00Z",
      projectKey: "project-a",
    });
    matching.archivedAt = new Date("2026-07-12T11:00:00Z");
    const active = agent({
      id: "active",
      title: "Active",
      updatedAt: "2026-07-12T10:00:00Z",
      projectKey: "project-a",
    });
    const oldArchived = agent({
      id: "old",
      title: "Old",
      updatedAt: "2026-06-01T10:00:00Z",
      projectKey: "project-a",
    });
    oldArchived.archivedAt = new Date("2026-06-01T11:00:00Z");

    expect(
      filterHistoryAgents([active, oldArchived, matching], {
        archiveState: "archived",
        includeArchived: true,
        projectKeys: ["project-a"],
        updatedAfter: "2026-07-01T00:00:00Z",
      }).map((item) => item.id),
    ).toEqual(["matching"]);
  });

  it("puts pins in one global section without duplicating them in project sections", () => {
    const ordered = dedupeAndSortHistoryAgents(
      [
        agent({
          id: "pinned",
          title: "Pinned",
          updatedAt: "2026-07-13T10:00:00Z",
          pinnedAt: "2026-07-13T11:00:00Z",
          projectKey: "project-b",
          projectName: "Beta",
        }),
        agent({
          id: "alpha",
          title: "Alpha",
          updatedAt: "2026-07-12T10:00:00Z",
          projectKey: "project-a",
          projectName: "Alpha project",
        }),
        agent({
          id: "beta",
          title: "Beta",
          updatedAt: "2026-07-11T10:00:00Z",
          projectKey: "project-b",
          projectName: "Beta",
        }),
      ],
      "recency",
    );

    const sections = buildHistorySections({ agents: ordered, groupMode: "project", now: NOW });
    const sectionSummary: Array<[string, string[]]> = [];
    for (const section of sections) {
      sectionSummary.push([section.key, section.agents.map((item) => item.id)]);
    }

    expect(sectionSummary).toEqual([
      ["pinned", ["pinned"]],
      ["project:project-a", ["alpha"]],
      ["project:project-b", ["beta"]],
    ]);
  });
});
