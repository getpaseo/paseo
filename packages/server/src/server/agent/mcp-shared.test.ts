import { afterEach, expect, test, vi } from "vitest";

import { AGENT_WAIT_TIMEOUT_MS, waitForAgentWithTimeout } from "./mcp-shared.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

interface StubManagerOptions {
  snapshot: ManagedAgent | null;
  historySnapshot?: ManagedAgent | null;
  getTimeline: () => AgentTimelineItem[];
}

function createStubManager(options: StubManagerOptions): AgentManager {
  return {
    waitForAgentEvent: (_agentId: string, waitOptions: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        waitOptions.signal?.addEventListener(
          "abort",
          () => reject(waitOptions.signal?.reason as Error),
          { once: true },
        );
      }),
    getAgent: () => options.snapshot,
    getHistorySnapshot: () => options.historySnapshot ?? null,
    getTimeline: options.getTimeline,
  } as unknown as AgentManager;
}

function createSnapshot(overrides: Partial<ManagedAgent>): ManagedAgent {
  return { id: "agent-1", lifecycle: "running", ...overrides } as unknown as ManagedAgent;
}

afterEach(() => {
  vi.useRealTimers();
});

test("wait timeout returns the friendly message when the timeline is not publicly readable", async () => {
  vi.useFakeTimers();
  const getTimeline = vi.fn(() => {
    throw new Error("Unknown agent 'agent-1'");
  });
  const manager = createStubManager({
    snapshot: createSnapshot({ internal: true }),
    getTimeline,
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  await vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS);
  const result = await pending;

  expect(result.status).toBe("running");
  expect(result.lastMessage).toContain("timed out after 30s");
  expect(result.lastMessage).toContain("No activity to display.");
  expect(getTimeline).not.toHaveBeenCalled();
});

test("wait timeout returns empty activity when the agent disappeared", async () => {
  vi.useFakeTimers();
  const getTimeline = vi.fn(() => []);
  const manager = createStubManager({ snapshot: null, getTimeline });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  await vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS);
  const result = await pending;

  expect(result.timedOut).toBe(true);
  expect(result.lastMessage).toContain("timed out after 30s");
  expect(result.lastMessage).toContain("No activity to display.");
  expect(getTimeline).not.toHaveBeenCalled();
});

test("wait timeout reports activity from a public history snapshot", async () => {
  vi.useFakeTimers();
  const getTimeline = vi.fn(() => [
    { type: "assistant_message" as const, text: "completed archived work" },
  ]);
  const manager = createStubManager({
    snapshot: null,
    historySnapshot: createSnapshot({ lifecycle: "closed", internal: false }),
    getTimeline,
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  await vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS);
  const result = await pending;

  expect(result.timedOut).toBe(true);
  expect(result.lastMessage).toContain("completed archived work");
  expect(getTimeline).toHaveBeenCalledExactlyOnceWith("agent-1");
});

test("wait timeout keeps internal history snapshot activity private", async () => {
  vi.useFakeTimers();
  const getTimeline = vi.fn(() => [
    { type: "assistant_message" as const, text: "private archived work" },
  ]);
  const manager = createStubManager({
    snapshot: null,
    historySnapshot: createSnapshot({ lifecycle: "closed", internal: true }),
    getTimeline,
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  await vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS);
  const result = await pending;

  expect(result.timedOut).toBe(true);
  expect(result.lastMessage).toContain("No activity to display.");
  expect(getTimeline).not.toHaveBeenCalled();
});

test("wait timeout still reports recent activity for readable agents", async () => {
  vi.useFakeTimers();
  const manager = createStubManager({
    snapshot: createSnapshot({}),
    getTimeline: () => [{ type: "assistant_message", text: "building the thing" }],
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  await vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS);
  const result = await pending;

  expect(result.lastMessage).toContain("building the thing");
});

test("wait timeout propagates unexpected timeline failures", async () => {
  vi.useFakeTimers();
  const failure = new Error("timeline read failed");
  const manager = createStubManager({
    snapshot: createSnapshot({}),
    getTimeline: () => {
      throw failure;
    },
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  const rejection = expect(pending).rejects.toBe(failure);
  await Promise.all([rejection, vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS)]);
});

test("wait timeout propagates unexpected activity formatting failures", async () => {
  vi.useFakeTimers();
  const failure = new Error("activity text unavailable");
  const manager = createStubManager({
    snapshot: createSnapshot({}),
    getTimeline: () => [
      {
        type: "assistant_message",
        get text(): string {
          throw failure;
        },
      },
    ],
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  const rejection = expect(pending).rejects.toBe(failure);
  await Promise.all([rejection, vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS)]);
});
