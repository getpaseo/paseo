import { describe, expect, it } from "vitest";
import type { ScheduleRowView } from "@/components/schedules/schedules-table";
import type { AggregatedSchedule } from "@/hooks/use-schedules";
import { filterScheduleRowsBySearchQuery } from "./schedule-list-search";

function schedule(
  overrides: Partial<AggregatedSchedule> & Pick<AggregatedSchedule, "id">,
): AggregatedSchedule {
  return {
    id: overrides.id,
    name: overrides.name ?? null,
    prompt: overrides.prompt ?? "check the deploy",
    cadence: overrides.cadence ?? { type: "cron", expression: "0 9 * * *" },
    target: overrides.target ?? {
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/tmp/repo",
        title: "Deploy watch",
      },
    },
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? "2026-07-30T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-30T00:00:00.000Z",
    nextRunAt: overrides.nextRunAt ?? null,
    lastRunAt: overrides.lastRunAt ?? null,
    pausedAt: overrides.pausedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    maxRuns: overrides.maxRuns ?? null,
    serverId: overrides.serverId ?? "local",
    serverName: overrides.serverName ?? "Local",
  };
}

function row(
  overrides: Partial<ScheduleRowView> & { schedule: AggregatedSchedule },
): ScheduleRowView {
  return {
    schedule: overrides.schedule,
    targetLabel: overrides.targetLabel ?? "New agent",
    provider: overrides.provider ?? "claude",
    state: overrides.state ?? "active",
    serverName: overrides.serverName ?? overrides.schedule.serverName,
    singleHost: overrides.singleHost ?? true,
  };
}

describe("filterScheduleRowsBySearchQuery", () => {
  const rows = [
    row({
      schedule: schedule({ id: "1", name: "Morning deploy", prompt: "check CI" }),
      targetLabel: "Deploy project",
      provider: "claude",
    }),
    row({
      schedule: schedule({ id: "2", name: null, prompt: "ping main build", serverName: "Laptop" }),
      targetLabel: "Untitled agent",
      provider: "codex",
      serverName: "Laptop",
    }),
  ];

  it("returns all rows for empty query", () => {
    expect(filterScheduleRowsBySearchQuery(rows, "  ").map((entry) => entry.schedule.id)).toEqual([
      "1",
      "2",
    ]);
  });

  it("filters by title, prompt, target, provider, and host", () => {
    expect(
      filterScheduleRowsBySearchQuery(rows, "morning").map((entry) => entry.schedule.id),
    ).toEqual(["1"]);
    expect(
      filterScheduleRowsBySearchQuery(rows, "build").map((entry) => entry.schedule.id),
    ).toEqual(["2"]);
    expect(
      filterScheduleRowsBySearchQuery(rows, "codex").map((entry) => entry.schedule.id),
    ).toEqual(["2"]);
    expect(
      filterScheduleRowsBySearchQuery(rows, "laptop").map((entry) => entry.schedule.id),
    ).toEqual(["2"]);
  });
});
