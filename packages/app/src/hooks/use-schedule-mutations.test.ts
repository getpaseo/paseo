import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import type {
  AggregatedSchedule,
  FetchAggregatedSchedulesResult,
} from "@/schedules/aggregated-schedules";
import { updateAggregatedSchedulesData } from "./use-schedule-mutations";

function schedule(overrides: Partial<AggregatedSchedule> = {}): AggregatedSchedule {
  const base: ScheduleSummary = {
    id: "schedule-1",
    name: "Nightly",
    prompt: "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp/project" } },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: "2026-07-02T01:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
  };
  return { ...base, serverId: "host-a", serverName: "Host A", ...overrides };
}

function pauseSchedules(schedules: AggregatedSchedule[]): AggregatedSchedule[] {
  return schedules.map((entry) => ({ ...entry, status: "paused" }));
}

describe("schedule mutation cache updates", () => {
  it("updates the canonical loaded data field", () => {
    const current: FetchAggregatedSchedulesResult = {
      status: "loaded",
      data: [schedule()],
      hostErrors: [],
    };

    const result = updateAggregatedSchedulesData(current, pauseSchedules);

    expect(result).toEqual({
      status: "loaded",
      data: [schedule({ status: "paused" })],
      hostErrors: [],
    });
  });

  it("leaves an empty cache entry empty", () => {
    const result = updateAggregatedSchedulesData(undefined, () => [schedule()]);

    expect(result).toBeUndefined();
  });
});
