import { afterEach, expect, test, vi } from "vitest";

import { AGENT_WAIT_TIMEOUT_MS, waitForAgentWithTimeout } from "./mcp-shared.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

interface StubManagerOptions {
  snapshot: ManagedAgent | null;
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
  const manager = createStubManager({
    snapshot: createSnapshot({ internal: true }),
    getTimeline: () => {
      throw new Error("Unknown agent 'agent-1'");
    },
  });

  const pending = waitForAgentWithTimeout(manager, "agent-1");
  await vi.advanceTimersByTimeAsync(AGENT_WAIT_TIMEOUT_MS);
  const result = await pending;

  expect(result.status).toBe("running");
  expect(result.lastMessage).toContain("timed out after 30s");
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
