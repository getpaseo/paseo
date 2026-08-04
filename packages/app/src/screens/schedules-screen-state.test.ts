import { describe, expect, it } from "vitest";
import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { resolveScheduleFocus, resolveSchedulesScreenBodyState } from "./schedules-screen-state";

describe("resolveSchedulesScreenBodyState", () => {
  it("routes failed loading state to the retry UI instead of the spinner", () => {
    expect(
      resolveSchedulesScreenBodyState({
        loadState: { status: "loading" },
        showLoadError: true,
      }),
    ).toEqual({ kind: "load-error" });
  });
});

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function makeSchedule(overrides: Partial<AggregatedSchedule> = {}): AggregatedSchedule {
  return {
    id: "schedule-1",
    name: "Watch the build",
    prompt: "Check on the build",
    cadence: { type: "every", everyMs: 900_000 },
    target: { type: "agent", agentId: AGENT_ID },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    serverId: "host-1",
    serverName: "Laptop",
    ...overrides,
  };
}

describe("resolveScheduleFocus", () => {
  it("stays out of the way when the route names no schedule", () => {
    expect(
      resolveScheduleFocus({
        focus: null,
        loadState: { status: "loaded", data: [makeSchedule()] },
      }),
    ).toEqual({ kind: "none" });
  });

  it("waits while schedules are still loading", () => {
    expect(
      resolveScheduleFocus({
        focus: { serverId: "host-1", scheduleId: "schedule-1" },
        loadState: { status: "loading" },
      }),
    ).toEqual({ kind: "pending" });
  });

  it("resolves the linked schedule on its own host", () => {
    const mine = makeSchedule({ id: "schedule-1", serverId: "host-1" });
    const sameIdOtherHost = makeSchedule({ id: "schedule-1", serverId: "host-2" });

    expect(
      resolveScheduleFocus({
        focus: { serverId: "host-1", scheduleId: "schedule-1" },
        loadState: { status: "loaded", data: [sameIdOtherHost, mine] },
      }),
    ).toEqual({ kind: "found", serverId: "host-1", schedule: mine });
  });

  it("falls back to the list when the link is stale", () => {
    expect(
      resolveScheduleFocus({
        focus: { serverId: "host-1", scheduleId: "deleted" },
        loadState: { status: "loaded", data: [makeSchedule()] },
      }),
    ).toEqual({ kind: "missing" });
  });
});
