import { describe, expect, it } from "vitest";
import { deriveFleetAgentInputs } from "./fleet-agent-input";
import { selectFleetSnapshot, type FleetAgentInput } from "./fleet-snapshot";

const SERVER_ID = "server-1";

function agent(
  overrides: Partial<FleetAgentInput> & Pick<FleetAgentInput, "agentId">,
): FleetAgentInput {
  return {
    serverId: SERVER_ID,
    title: overrides.agentId,
    running: false,
    error: false,
    ...overrides,
  };
}

describe("selectFleetSnapshot", () => {
  it("returns an inactive snapshot for an empty fleet", () => {
    expect(selectFleetSnapshot([], null)).toEqual({
      active: false,
      hero: null,
      needsYouCount: 0,
      runningCount: 0,
    });
  });

  it("promotes the sole running agent to hero in a degenerate fleet", () => {
    const snapshot = selectFleetSnapshot(
      [agent({ agentId: "a1", running: true, runningSinceMs: 1000, phase: "editing" })],
      null,
    );
    expect(snapshot).toEqual({
      active: true,
      hero: {
        agentId: "a1",
        serverId: SERVER_ID,
        title: "a1",
        state: "running",
        permissionToolName: undefined,
        phase: "editing",
        todoDone: undefined,
        todoTotal: undefined,
        sinceMs: 1000,
      },
      needsYouCount: 0,
      runningCount: 1,
      longestRunningSinceMs: 1000,
    });
  });

  it("prioritizes pending permission over error, waiting, and running", () => {
    const agents = [
      agent({ agentId: "runner", running: true, runningSinceMs: 500 }),
      agent({ agentId: "waiter", needsAttentionSinceMs: 400 }),
      agent({ agentId: "erroring", error: true }),
      agent({
        agentId: "blocked",
        pendingPermission: { requestId: "req-blocked", toolName: "bash", sinceMs: 900 },
      }),
    ];
    expect(selectFleetSnapshot(agents, null).hero?.agentId).toBe("blocked");
  });

  it("prioritizes error over waiting and running when no permission is pending", () => {
    const agents = [
      agent({ agentId: "runner", running: true, runningSinceMs: 500 }),
      agent({ agentId: "waiter", needsAttentionSinceMs: 400 }),
      agent({ agentId: "erroring", error: true }),
    ];
    const snapshot = selectFleetSnapshot(agents, null);
    expect(snapshot.hero?.agentId).toBe("erroring");
    expect(snapshot.hero?.state).toBe("error");
  });

  it("maps error status to heroState error even when needsAttentionSinceMs is also set", () => {
    const agents = [
      agent({
        agentId: "erroring",
        error: true,
        needsAttentionSinceMs: 400,
        errorSinceMs: 900,
      }),
    ];
    const snapshot = selectFleetSnapshot(agents, null);
    expect(snapshot.hero?.state).toBe("error");
    expect(snapshot.hero?.sinceMs).toBe(900);
  });

  it("uses errorSinceMs for an error hero and never falls back to epoch 0 in production shape", () => {
    const attentionTimestamp = new Date("2026-04-01T02:30:00.000Z");
    const agentRecord = {
      serverId: "server-a",
      id: "agent-error01",
      provider: "codex" as const,
      status: "error" as const,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T01:00:00.000Z"),
      lastUserMessageAt: null,
      lastActivityAt: new Date("2026-04-01T02:00:00.000Z"),
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: "Broken agent",
      cwd: "/repo",
      model: null,
      parentAgentId: null,
      labels: {},
      archivedAt: null,
      activeTurn: null,
      requiresAttention: true,
      attentionReason: "error" as const,
      attentionTimestamp,
    };
    const inputs = deriveFleetAgentInputs(new Map([[agentRecord.id, agentRecord]]), new Map());
    const snapshot = selectFleetSnapshot(inputs, null);
    expect(snapshot.hero?.state).toBe("error");
    expect(snapshot.hero?.sinceMs).toBe(attentionTimestamp.getTime());
    expect(snapshot.hero?.sinceMs).toBeGreaterThan(0);
  });

  it("prioritizes the longest-waiting needs_you agent over running", () => {
    const agents = [
      agent({ agentId: "runner", running: true, runningSinceMs: 500 }),
      agent({ agentId: "shortWait", needsAttentionSinceMs: 900 }),
      agent({ agentId: "longWait", needsAttentionSinceMs: 100 }),
    ];
    expect(selectFleetSnapshot(agents, null).hero?.agentId).toBe("longWait");
  });

  it("prioritizes the longest-running agent among plain running agents", () => {
    const agents = [
      agent({ agentId: "shortRun", running: true, runningSinceMs: 900 }),
      agent({ agentId: "longRun", running: true, runningSinceMs: 100 }),
    ];
    expect(selectFleetSnapshot(agents, null).hero?.agentId).toBe("longRun");
  });

  it("keeps the current hero when no candidate reaches a strictly higher priority class", () => {
    const agents = [
      agent({ agentId: "hero", running: true, runningSinceMs: 900 }),
      agent({ agentId: "fresherRunner", running: true, runningSinceMs: 100 }),
    ];
    expect(selectFleetSnapshot(agents, "hero").hero?.agentId).toBe("hero");
  });

  it("keeps the current hero over a same-class needs_you agent with a longer wait", () => {
    const agents = [
      agent({ agentId: "hero", needsAttentionSinceMs: 900 }),
      agent({ agentId: "longerWait", needsAttentionSinceMs: 100 }),
    ];
    expect(selectFleetSnapshot(agents, "hero").hero?.agentId).toBe("hero");
  });

  it("swaps the hero when a candidate reaches a strictly higher priority class", () => {
    const agents = [
      agent({ agentId: "hero", running: true, runningSinceMs: 900 }),
      agent({
        agentId: "blocked",
        pendingPermission: { requestId: "req-blocked", toolName: "bash", sinceMs: 100 },
      }),
    ];
    expect(selectFleetSnapshot(agents, "hero").hero?.agentId).toBe("blocked");
  });

  it("swaps the hero once it leaves the active set", () => {
    const agents = [agent({ agentId: "next", running: true, runningSinceMs: 500 })];
    expect(selectFleetSnapshot(agents, "gone").hero?.agentId).toBe("next");
  });

  it("counts needs-you and running agents without double-counting a running error", () => {
    const agents = [
      agent({ agentId: "runner", running: true, runningSinceMs: 500 }),
      agent({ agentId: "runningError", running: true, error: true }),
      agent({ agentId: "waiter", needsAttentionSinceMs: 400 }),
      agent({
        agentId: "blocked",
        pendingPermission: { requestId: "req-blocked", toolName: "bash", sinceMs: 900 },
      }),
    ];
    const snapshot = selectFleetSnapshot(agents, null);
    expect(snapshot.needsYouCount).toBe(3);
    expect(snapshot.runningCount).toBe(1);
  });

  it("computes longestRunningSinceMs from plain running agents only", () => {
    const agents = [
      agent({ agentId: "slow", running: true, runningSinceMs: 900 }),
      agent({ agentId: "fast", running: true, runningSinceMs: 100 }),
      agent({
        agentId: "runningNeedsAttention",
        running: true,
        runningSinceMs: 1,
        needsAttentionSinceMs: 50,
      }),
    ];
    expect(selectFleetSnapshot(agents, null).longestRunningSinceMs).toBe(100);
  });

  it("omits longestRunningSinceMs when no plain running agent exists", () => {
    const agents = [agent({ agentId: "waiter", needsAttentionSinceMs: 400 })];
    expect(selectFleetSnapshot(agents, null).longestRunningSinceMs).toBeUndefined();
  });
});
