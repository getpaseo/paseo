import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { filterAgentsByArchivedState, resolveSessionsEmptyText } from "./sessions-screen-state";

function agent(id: string, archivedAt?: string | null): AggregatedAgent {
  return { id, archivedAt } as unknown as AggregatedAgent;
}

const archived = agent("archived", "2026-03-02T12:00:00.000Z");
const live = agent("live", null);
const neverArchived = agent("never");

describe("filterAgentsByArchivedState", () => {
  const agents = [live, archived, neverArchived];

  it("keeps the caller's array untouched for `all`", () => {
    expect(filterAgentsByArchivedState(agents, "all")).toBe(agents);
  });

  it("drops archived rows for `active`", () => {
    expect(filterAgentsByArchivedState(agents, "active")).toEqual([live, neverArchived]);
  });

  it("keeps only archived rows for `archived`", () => {
    expect(filterAgentsByArchivedState(agents, "archived")).toEqual([archived]);
  });

  it("returns an empty list instead of the input when nothing matches", () => {
    expect(filterAgentsByArchivedState([live], "archived")).toEqual([]);
  });
});

describe("resolveSessionsEmptyText", () => {
  const t = ((key: string) => key) as unknown as TFunction;

  it("prefers the search message over the filter message", () => {
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: true,
        isAllHosts: true,
        archivedFilter: "archived",
        hasMore: true,
      }),
    ).toBe("sessions.noMatches");
  });

  it("names the archived filter when it emptied the list", () => {
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: false,
        isAllHosts: true,
        archivedFilter: "archived",
        hasMore: false,
      }),
    ).toBe("sessions.archivedFilter.emptyArchived");
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: false,
        isAllHosts: true,
        archivedFilter: "active",
        hasMore: false,
      }),
    ).toBe("sessions.archivedFilter.emptyActive");
  });

  it("does not claim a filter is empty while later pages are unfetched", () => {
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: false,
        isAllHosts: true,
        archivedFilter: "archived",
        hasMore: true,
      }),
    ).toBe("sessions.archivedFilter.emptyLoaded");
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: false,
        isAllHosts: true,
        archivedFilter: "active",
        hasMore: true,
      }),
    ).toBe("sessions.archivedFilter.emptyLoaded");
  });

  it("falls back to the plain empty text without a query or a filter", () => {
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: false,
        isAllHosts: true,
        archivedFilter: "all",
        hasMore: false,
      }),
    ).toBe("sessions.empty");
    expect(
      resolveSessionsEmptyText({
        t,
        isSearching: false,
        isAllHosts: false,
        archivedFilter: "all",
        hasMore: false,
      }),
    ).toBe("No sessions for this host");
  });
});
