import { describe, expect, it } from "vitest";
import type { ProviderHeartbeatDescriptorPayload } from "@getpaseo/protocol/messages";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import {
  mergeHeartbeatRows,
  selectPaseoHeartbeatRows,
  selectProviderHeartbeatRows,
  type HeartbeatRow,
} from "./select";

function makeSchedule(
  overrides: Partial<ScheduleSummary> & Pick<ScheduleSummary, "id" | "target">,
): ScheduleSummary {
  return {
    name: null,
    prompt: "Check deploy",
    cadence: { type: "every", everyMs: 60_000 },
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    nextRunAt: "2026-08-02T01:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    ...overrides,
  };
}

function makeProvider(
  overrides: Partial<ProviderHeartbeatDescriptorPayload> &
    Pick<ProviderHeartbeatDescriptorPayload, "taskId" | "parentAgentId">,
): ProviderHeartbeatDescriptorPayload {
  return {
    provider: "claude",
    prompt: "loop prompt",
    mode: "recurring",
    scheduleLabel: "every 5m",
    nextHint: "in 4m",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectPaseoHeartbeatRows", () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const otherAgentId = "22222222-2222-4222-8222-222222222222";
  const serverId = "srv-a";

  const schedules: ScheduleSummary[] = [
    makeSchedule({
      id: "hb-active",
      name: "Deploy watch",
      target: { type: "agent", agentId },
      status: "active",
      nextRunAt: "2026-08-02T01:00:00.000Z",
    }),
    makeSchedule({
      id: "hb-paused",
      name: null,
      prompt: "Paused prompt",
      target: { type: "agent", agentId },
      status: "paused",
      nextRunAt: null,
      cadence: { type: "cron", expression: "0 9 * * *" },
    }),
    makeSchedule({
      id: "hb-completed",
      target: { type: "agent", agentId },
      status: "completed",
    }),
    makeSchedule({
      id: "hb-other-agent",
      target: { type: "agent", agentId: otherAgentId },
      status: "active",
    }),
    makeSchedule({
      id: "hb-new-agent",
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: "/tmp" },
      },
      status: "active",
    }),
  ];

  it("includes active and paused agent-target schedules for the agent", () => {
    const rows = selectPaseoHeartbeatRows({
      agentId,
      serverId,
      schedules,
    });
    expect(rows.map((row) => row.id)).toEqual(["hb-active", "hb-paused"]);
  });

  it("maps cadence labels and status onto paseo rows", () => {
    const rows = selectPaseoHeartbeatRows({
      agentId,
      serverId,
      schedules,
    });
    expect(rows).toContainEqual({
      kind: "paseo",
      id: "hb-active",
      name: "Deploy watch",
      prompt: "Check deploy",
      status: "active",
      cadenceLabel: "Every 1 minute",
      nextRunAt: "2026-08-02T01:00:00.000Z",
      serverId,
    } satisfies HeartbeatRow);
    expect(rows).toContainEqual({
      kind: "paseo",
      id: "hb-paused",
      name: null,
      prompt: "Paused prompt",
      status: "paused",
      cadenceLabel: "Daily at 09:00 UTC",
      nextRunAt: null,
      serverId,
    } satisfies HeartbeatRow);
  });

  it("excludes completed, other-agent, and new-agent schedules", () => {
    const rows = selectPaseoHeartbeatRows({
      agentId,
      serverId,
      schedules,
    });
    expect(rows.map((row) => row.id)).not.toContain("hb-completed");
    expect(rows.map((row) => row.id)).not.toContain("hb-other-agent");
    expect(rows.map((row) => row.id)).not.toContain("hb-new-agent");
  });
});

describe("selectProviderHeartbeatRows", () => {
  it("maps provider descriptors to provider heartbeat rows", () => {
    const rows = selectProviderHeartbeatRows([
      makeProvider({
        taskId: "task-1",
        parentAgentId: "agent-a",
        mode: "dynamic",
        scheduleLabel: "self-paced",
        nextHint: null,
        prompt: "keep checking",
        provider: "claude",
      }),
    ]);
    expect(rows).toEqual([
      {
        kind: "provider",
        id: "task-1",
        parentAgentId: "agent-a",
        provider: "claude",
        prompt: "keep checking",
        mode: "dynamic",
        scheduleLabel: "self-paced",
        nextHint: null,
      } satisfies HeartbeatRow,
    ]);
  });
});

describe("mergeHeartbeatRows", () => {
  it("concatenates paseo then provider without reordering within groups", () => {
    const paseo: HeartbeatRow[] = [
      {
        kind: "paseo",
        id: "p1",
        name: "A",
        prompt: "a",
        status: "active",
        cadenceLabel: "Every 1 minute",
        nextRunAt: null,
        serverId: "srv",
      },
    ];
    const provider: HeartbeatRow[] = [
      {
        kind: "provider",
        id: "t1",
        parentAgentId: "agent-a",
        provider: "claude",
        prompt: "b",
        mode: "one_shot",
        scheduleLabel: "once",
        nextHint: "soon",
      },
    ];
    expect(mergeHeartbeatRows(paseo, provider)).toEqual([...paseo, ...provider]);
  });
});
