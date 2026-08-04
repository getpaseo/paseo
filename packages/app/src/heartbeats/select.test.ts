import { describe, expect, it } from "vitest";
import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { selectAgentHeartbeats, selectAgentHeartbeatsTrack } from "./select";

const NOW = Date.parse("2026-07-02T00:00:00.000Z");
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000002";

function makeHeartbeat(overrides: Partial<AggregatedSchedule> = {}): AggregatedSchedule {
  return {
    id: "schedule-1",
    name: "Watch the build",
    prompt: "Check on the build",
    cadence: { type: "every", everyMs: 900_000 },
    target: { type: "agent", agentId: AGENT_ID },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: "2026-07-02T01:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    serverId: "host-1",
    serverName: "Laptop",
    ...overrides,
  };
}

function select(schedules: AggregatedSchedule[], agentId = AGENT_ID, serverId = "host-1") {
  return selectAgentHeartbeats({
    schedules,
    target: { serverId, agentId },
    now: NOW,
  });
}

describe("selectAgentHeartbeats", () => {
  it("shows the heartbeat title and human cadence for the current agent", () => {
    expect(select([makeHeartbeat()])).toEqual([
      {
        key: "host-1:schedule-1",
        serverId: "host-1",
        scheduleId: "schedule-1",
        title: "Watch the build",
        cadence: "Every 15 minutes",
      },
    ]);
  });

  it("falls back to the first prompt line when the heartbeat has no name", () => {
    const rows = select([
      makeHeartbeat({ name: null, prompt: "  \nCheck the deploy\nthen report" }),
    ]);

    expect(rows.map((row) => row.title)).toEqual(["Check the deploy"]);
  });

  it("describes cron cadences in words", () => {
    const rows = select([
      makeHeartbeat({ cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "UTC" } }),
    ]);

    expect(rows.map((row) => row.cadence)).toEqual(["Weekdays at 09:00 UTC"]);
  });

  it("ignores schedules targeting another agent or another host", () => {
    const rows = select([
      makeHeartbeat({ id: "mine" }),
      makeHeartbeat({ id: "other-agent", target: { type: "agent", agentId: OTHER_AGENT_ID } }),
      makeHeartbeat({ id: "other-host", serverId: "host-2" }),
    ]);

    expect(rows.map((row) => row.scheduleId)).toEqual(["mine"]);
  });

  it("ignores schedules that create new agents", () => {
    const rows = select([
      makeHeartbeat({
        id: "new-agent",
        target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp/project" } },
      }),
    ]);

    expect(rows).toEqual([]);
  });

  it("keeps only heartbeats that are still running on a cadence", () => {
    const rows = select([
      makeHeartbeat({ id: "active" }),
      makeHeartbeat({ id: "paused", status: "paused" }),
      makeHeartbeat({ id: "completed", status: "completed" }),
      makeHeartbeat({ id: "expired", expiresAt: "2026-07-01T00:00:00.000Z" }),
    ]);

    expect(rows.map((row) => row.scheduleId)).toEqual(["active"]);
  });

  it("keys rows by host and schedule so ids cannot collide across hosts", () => {
    const rows = selectAgentHeartbeats({
      schedules: [makeHeartbeat({ serverId: "host-2", serverName: "Desktop" })],
      target: { serverId: "host-2", agentId: AGENT_ID },
      now: NOW,
    });

    expect(rows.map((row) => row.key)).toEqual(["host-2:schedule-1"]);
  });

  it("orders heartbeats oldest first", () => {
    const rows = select([
      makeHeartbeat({ id: "newer", createdAt: "2026-07-01T10:00:00.000Z" }),
      makeHeartbeat({ id: "older", createdAt: "2026-07-01T09:00:00.000Z" }),
    ]);

    expect(rows.map((row) => row.scheduleId)).toEqual(["older", "newer"]);
  });

  it("returns the same empty list when nothing matches", () => {
    expect(select([])).toBe(select([makeHeartbeat({ status: "paused" })]));
  });
});

function selectTrack(schedules: AggregatedSchedule[], showsHeartbeatActivity: boolean) {
  return selectAgentHeartbeatsTrack({
    schedules,
    target: { serverId: "host-1", agentId: AGENT_ID },
    now: NOW,
    showsHeartbeatActivity,
  });
}

describe("selectAgentHeartbeatsTrack", () => {
  it("lists the heartbeats when the host reports their activity", () => {
    const track = selectTrack([makeHeartbeat()], true);

    expect(track.kind).toBe("heartbeats");
    expect(track.kind === "heartbeats" ? track.rows.map((row) => row.scheduleId) : []).toEqual([
      "schedule-1",
    ]);
  });

  it("asks for a host update instead of listing heartbeats whose activity the host hides", () => {
    expect(selectTrack([makeHeartbeat()], false)).toEqual({ kind: "host-update-required" });
  });

  it("shows no track on a host without activity reporting when no heartbeat targets this agent", () => {
    expect(selectTrack([makeHeartbeat({ status: "paused" })], false)).toEqual({ kind: "none" });
    expect(selectTrack([], false)).toEqual({ kind: "none" });
  });

  it("shows no track when the host reports activity but nothing targets this agent", () => {
    expect(selectTrack([], true)).toEqual({ kind: "none" });
  });
});
