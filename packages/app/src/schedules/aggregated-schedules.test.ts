import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import {
  fetchAggregatedSchedules,
  type ScheduleRuntime,
  type ScheduleRuntimeSnapshot,
} from "./aggregated-schedules";

function makeSchedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
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
    ...overrides,
  };
}

function makeRuntime(input: {
  snapshots: Record<string, ScheduleRuntimeSnapshot | null>;
  schedules?: Record<string, ScheduleSummary[]>;
}): ScheduleRuntime {
  return {
    getSnapshot: (serverId) => input.snapshots[serverId] ?? null,
    getClient: (serverId) => {
      const schedules = input.schedules?.[serverId];
      if (!schedules) {
        return null;
      }
      return {
        scheduleList: async () => ({ requestId: "test-request", schedules, error: null }),
      };
    },
  };
}

describe("fetchAggregatedSchedules load state", () => {
  it("does not report loaded empty while known hosts are still connecting", async () => {
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "connecting" },
          "host-b": { connectionStatus: "connecting" },
        },
      }),
    });

    expect(result.status).not.toBe("loaded");
    expect(result).toEqual({ status: "connecting" });
  });

  it("reports loaded empty after all reachable hosts answer with no schedules", async () => {
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "online" },
        },
        schedules: {
          "host-a": [],
          "host-b": [],
        },
      }),
    });

    expect(result).toEqual({ status: "loaded", data: [], hostErrors: [] });
  });

  it("does not report loaded empty while another known host is still connecting", async () => {
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "connecting" },
        },
        schedules: {
          "host-a": [],
        },
      }),
    });

    expect(result).toEqual({ status: "connecting" });
  });

  it("loads reachable host data when another known host is still connecting", async () => {
    const schedule = makeSchedule();
    const result = await fetchAggregatedSchedules({
      hosts: [
        { serverId: "host-a", serverName: "Host A" },
        { serverId: "host-b", serverName: "Host B" },
      ],
      runtime: makeRuntime({
        snapshots: {
          "host-a": { connectionStatus: "online" },
          "host-b": { connectionStatus: "connecting" },
        },
        schedules: {
          "host-a": [schedule],
        },
      }),
    });

    expect(result).toEqual({
      status: "loaded",
      data: [{ ...schedule, serverId: "host-a", serverName: "Host A" }],
      hostErrors: [],
    });
  });
});
