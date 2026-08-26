import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { AgentWatchdogNotifier, watchdogWakeClientMessageId } from "./notifier.js";
import type { StoredWatchdogJob } from "./service.js";

const agent = {
  id: "agent-1",
  provider: "codex",
  cwd: "/workspace",
  workspaceId: "workspace-1",
  lifecycle: "idle",
  currentModeId: "build",
  availableModes: [],
  config: { title: "Agent" },
} as unknown as ManagedAgent;

const job = {
  id: "watchdog-1",
  name: "vision tests",
  agentId: agent.id,
  workspaceId: "workspace-1",
  cwd: "/workspace",
  command: "npm",
  args: ["test"],
  status: "completed",
  deliveryStatus: "pending",
  workerPid: 4101,
  result: {
    exitCode: 0,
    signal: null,
    error: null,
    finishedAt: "2026-08-19T00:05:00.000Z",
    stdout: { bytes: 4, truncated: false },
    stderr: { bytes: 0, truncated: false },
  },
  timeoutMs: null,
  cancelRequestedAt: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:05:00.000Z",
  deliveredAt: null,
} satisfies StoredWatchdogJob;

describe("AgentWatchdogNotifier", () => {
  test("delivers through the canonical submitted-prompt path with a deterministic message id", async () => {
    const streamAgent = vi.fn(async function* () {
      yield { type: "message", message: "accepted" } as never;
    });
    const waitForAgentRunStart = vi.fn(async () => undefined);
    const notifier = createNotifier({ streamAgent, waitForAgentRunStart });

    await expect(notifier.notify(job)).resolves.toBe("delivered");
    expect(streamAgent).toHaveBeenCalledWith(
      agent.id,
      expect.stringContaining(`[PASEO_WATCHDOG job=${job.id}]`),
      expect.objectContaining({ clientMessageId: watchdogWakeClientMessageId(job.id) }),
    );
    expect(waitForAgentRunStart).toHaveBeenCalledWith(agent.id, expect.anything());
  });

  test("a second notification attempt does not call streamAgent when the wake is already on the timeline", async () => {
    const wakeId = watchdogWakeClientMessageId(job.id);
    const streamAgent = vi.fn(async function* () {
      yield { type: "message", message: "accepted" } as never;
    });
    let timeline: Array<{ type: "user_message"; text: string; clientMessageId: string }> = [];
    let timelineRows: Array<{
      seq: number;
      timestamp: string;
      item: { type: "user_message"; text: string; clientMessageId: string };
    }> = [];
    const notifier = createNotifier({
      streamAgent,
      getTimeline: () => timeline,
      getTimelineRows: async () => timelineRows,
    });

    await expect(notifier.notify(job)).resolves.toBe("delivered");
    expect(streamAgent).toHaveBeenCalledTimes(1);

    timeline = [{ type: "user_message", text: "wake", clientMessageId: wakeId }];
    timelineRows = [
      {
        seq: 1,
        timestamp: "2026-08-19T00:05:00.000Z",
        item: { type: "user_message", text: "wake", clientMessageId: wakeId },
      },
    ];
    await expect(notifier.notify(job)).resolves.toBe("delivered");
    expect(streamAgent).toHaveBeenCalledTimes(1);
  });

  test("leaves delivery pending when the agent is busy", async () => {
    const streamAgent = vi.fn(async function* () {
      yield { type: "message", message: "accepted" } as never;
    });
    const notifier = createNotifier({
      streamAgent,
      hasInFlightRun: () => true,
    });

    await expect(notifier.notify(job)).resolves.toBe("busy");
    expect(streamAgent).not.toHaveBeenCalled();
  });

  test("leaves delivery pending when the agent has pending permissions", async () => {
    const streamAgent = vi.fn(async function* () {
      yield { type: "message", message: "accepted" } as never;
    });
    const notifier = createNotifier({
      streamAgent,
      getPendingPermissions: () => [{ id: "perm-1" } as never],
    });

    await expect(notifier.notify(job)).resolves.toBe("busy");
    expect(streamAgent).not.toHaveBeenCalled();
  });

  test("does not acknowledge when run start fails", async () => {
    const notifier = createNotifier({
      streamAgent: async function* () {
        yield { type: "message", message: "accepted" } as never;
      },
      waitForAgentRunStart: async () => {
        throw new Error("authentication failed");
      },
    });

    await expect(notifier.notify(job)).rejects.toThrow("authentication failed");
  });
});

function createNotifier(options: {
  streamAgent: AgentManager["streamAgent"];
  waitForAgentRunStart?: AgentManager["waitForAgentRunStart"];
  hasInFlightRun?: () => boolean;
  getPendingPermissions?: () => unknown[];
  getTimeline?: AgentManager["getTimeline"];
  getTimelineRows?: AgentManager["getTimelineRows"];
}): AgentWatchdogNotifier {
  const agentManager = {
    getAgent: vi.fn(() => agent),
    waitForAgentClose: vi.fn(),
    waitForAgentRunStart: options.waitForAgentRunStart ?? vi.fn(async () => undefined),
    hasInFlightRun: vi.fn(options.hasInFlightRun ?? (() => false)),
    getPendingPermissions: vi.fn(options.getPendingPermissions ?? (() => [])),
    getTimeline: vi.fn(options.getTimeline ?? (() => [])),
    getTimelineRows: vi.fn(options.getTimelineRows ?? (async () => [])),
    tryRunOutOfBand: vi.fn(() => false),
    steerOrReplaceActiveTurn: vi.fn(async () => ({ status: "inactive" as const })),
    streamAgent: vi.fn(options.streamAgent),
    setAgentMode: vi.fn(),
    unarchiveSnapshot: vi.fn(),
    notifyAgentState: vi.fn(),
  } as unknown as AgentManager;
  const agentStorage = {
    get: vi.fn(async () => ({ id: agent.id, archivedAt: null })),
  } as unknown as AgentStorage;
  return new AgentWatchdogNotifier("/tmp/paseo", agentManager, agentStorage, createTestLogger());
}
