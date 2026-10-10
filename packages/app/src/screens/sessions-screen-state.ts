import type { TFunction } from "i18next";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

/**
 * Which archived state the History list is narrowed to. The daemon answers one
 * page holding both archived and live sessions, so this is a view filter over
 * the rows the screen already has rather than a change to the query.
 */
export type SessionsArchivedFilter = "all" | "active" | "archived";

/** `all` returns the caller's array so the list keeps its identity at rest. */
export function filterAgentsByArchivedState(
  agents: AggregatedAgent[],
  filter: SessionsArchivedFilter,
): AggregatedAgent[] {
  if (filter === "all") {
    return agents;
  }
  return agents.filter((agent) =>
    filter === "archived" ? Boolean(agent.archivedAt) : !agent.archivedAt,
  );
}

/** An empty list means something different once a query or a filter narrows it. */
export function resolveSessionsEmptyText(input: {
  t: TFunction;
  isSearching: boolean;
  isAllHosts: boolean;
  archivedFilter: SessionsArchivedFilter;
  /**
   * Later pages exist. A filter-specific message claims that kind is empty,
   * which the loaded page cannot support while more rows are still unfetched.
   */
  hasMore: boolean;
}): string {
  if (input.isSearching) {
    return input.t("sessions.noMatches");
  }
  if (input.archivedFilter === "archived") {
    return input.hasMore
      ? input.t("sessions.archivedFilter.emptyLoaded")
      : input.t("sessions.archivedFilter.emptyArchived");
  }
  if (input.archivedFilter === "active") {
    return input.hasMore
      ? input.t("sessions.archivedFilter.emptyLoaded")
      : input.t("sessions.archivedFilter.emptyActive");
  }
  if (input.isAllHosts) {
    return input.t("sessions.empty");
  }
  return "No sessions for this host";
}
