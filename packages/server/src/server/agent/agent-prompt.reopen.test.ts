import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { startAgentRun, type AgentRunController } from "./agent-prompt.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";
import { ClosedProviderSessionError, StaleProviderSessionError } from "./stale-provider-session-error.js";

const logger = createTestLogger();

async function* emptyRun(): AsyncGenerator<AgentStreamEvent> {}

async function* failingRun(error: Error): AsyncGenerator<AgentStreamEvent> {
  throw error;
}

/**
 * Controller whose first stream attempt fails and whose retry succeeds, so a reopen
 * is observable as reloadAgentSession + a second streamAgent call.
 */
function fakeController(failure: Error) {
  const calls = { stream: 0, reload: 0 };
  const controller = {
    getAgent: () => ({ provider: "codex", persistence: { provider: "codex", sessionId: "sess-1" } }),
    tryRunOutOfBand: async () => false,
    hasInFlightRun: () => false,
    reloadStalePluginSession: async () => undefined,
    replaceAgentRun: async () => emptyRun(),
    steerOrReplaceActiveTurn: async () => null,
    streamAgent: () => {
      calls.stream += 1;
      return calls.stream === 1 ? failingRun(failure) : emptyRun();
    },
    reloadAgentSession: async () => {
      calls.reload += 1;
    },
  } as unknown as AgentRunController;
  return { controller, calls };
}

// The failure arrives while the run is drained, after startAgentRun has returned, so
// every assertion waits for the reopen instead of assuming it already happened.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test("a closed provider session is reopened from persistence and the prompt retried", async () => {
  const { controller, calls } = fakeController(new ClosedProviderSessionError("sess-1"));

  const result = await startAgentRun(controller, "agent-1", "continue", logger);

  expect(result.disposition).toBe("turn_started");
  await settle();
  expect(calls.reload).toBe(1);
  expect(calls.stream).toBe(2);
});

test("a stale plugin session still reopens (existing behaviour preserved)", async () => {
  const { controller, calls } = fakeController(new StaleProviderSessionError("sess-1"));

  await startAgentRun(controller, "agent-1", "continue", logger);

  await settle();
  expect(calls.reload).toBe(1);
  expect(calls.stream).toBe(2);
});

test("a closed session that fails before a run exists is reopened too", async () => {
  // The other reopen site: streamAgent itself throws, before any iterator exists.
  const calls = { stream: 0, reload: 0 };
  const controller = {
    getAgent: () => ({ provider: "codex", persistence: { provider: "codex", sessionId: "sess-1" } }),
    tryRunOutOfBand: async () => false,
    hasInFlightRun: () => false,
    reloadStalePluginSession: async () => undefined,
    replaceAgentRun: async () => emptyRun(),
    steerOrReplaceActiveTurn: async () => null,
    streamAgent: () => {
      calls.stream += 1;
      if (calls.stream === 1) throw new ClosedProviderSessionError("sess-1");
      return emptyRun();
    },
    reloadAgentSession: async () => {
      calls.reload += 1;
    },
  } as unknown as AgentRunController;

  const result = await startAgentRun(controller, "agent-1", "continue", logger);

  expect(result.disposition).toBe("turn_started");
  expect(calls.reload).toBe(1);
  expect(calls.stream).toBe(2);
});

test("a generic provider failure is surfaced without reopening the session", async () => {
  const { controller, calls } = fakeController(new Error("provider exploded"));

  await startAgentRun(controller, "agent-1", "continue", logger);

  await settle();
  expect(calls.reload).toBe(0);
  expect(calls.stream).toBe(1);
});

test("a closed session keeps the message the host reported", () => {
  expect(new ClosedProviderSessionError("sess-1").message).toBe("Provider session sess-1 closed");
  expect(new ClosedProviderSessionError("sess-1", "host said why").message).toBe("host said why");
});
