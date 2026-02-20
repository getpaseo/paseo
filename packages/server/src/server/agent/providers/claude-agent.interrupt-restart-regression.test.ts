import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const sdkMocks = vi.hoisted(() => ({
  query: vi.fn(),
  firstQuery: null as QueryMock | null,
  secondQuery: null as QueryMock | null,
  releaseOldAssistant: null as (() => void) | null,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdkMocks.query,
}));

type QueryMock = {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildUsage() {
  return {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  };
}

function buildFirstQueryMock(
  allowOldAssistant: Promise<void>
): QueryMock {
  let step = 0;
  return {
    next: vi.fn(async () => {
      if (step === 0) {
        step += 1;
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            session_id: "interrupt-regression-session",
            permissionMode: "default",
            model: "opus",
          },
        };
      }
      if (step === 1) {
        await allowOldAssistant;
        step += 1;
        return {
          done: false,
          value: {
            type: "assistant",
            message: {
              content: "OLD_TURN_RESPONSE",
            },
          },
        };
      }
      if (step === 2) {
        step += 1;
        return {
          done: false,
          value: {
            type: "result",
            subtype: "success",
            usage: buildUsage(),
            total_cost_usd: 0,
          },
        };
      }
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => {
      throw new Error("simulated interrupt failure");
    }),
    return: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
  };
}

function buildSecondQueryMock(): QueryMock {
  let step = 0;
  return {
    next: vi.fn(async () => {
      if (step === 0) {
        step += 1;
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            session_id: "interrupt-regression-session",
            permissionMode: "default",
            model: "opus",
          },
        };
      }
      if (step === 1) {
        step += 1;
        return {
          done: false,
          value: {
            type: "assistant",
            message: {
              content: "NEW_TURN_RESPONSE",
            },
          },
        };
      }
      if (step === 2) {
        step += 1;
        return {
          done: false,
          value: {
            type: "result",
            subtype: "success",
            usage: buildUsage(),
            total_cost_usd: 0,
          },
        };
      }
      return { done: true, value: undefined };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
  };
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

function collectAssistantText(events: AgentStreamEvent[]): string {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline" && event.item.type === "assistant_message"
    )
    .map((event) => event.item.text)
    .join("");
}

describe("ClaudeAgentSession interrupt restart regression", () => {
  beforeEach(() => {
    const allowOldAssistant = deferred<void>();
    let queryCreateCount = 0;

    sdkMocks.query.mockImplementation(() => {
      queryCreateCount += 1;
      if (queryCreateCount === 1) {
        const mock = buildFirstQueryMock(allowOldAssistant.promise);
        sdkMocks.firstQuery = mock;
        return mock;
      }
      const mock = buildSecondQueryMock();
      sdkMocks.secondQuery = mock;
      return mock;
    });
    sdkMocks.releaseOldAssistant = () => allowOldAssistant.resolve();
  });

  afterEach(() => {
    sdkMocks.query.mockReset();
    sdkMocks.firstQuery = null;
    sdkMocks.secondQuery = null;
    sdkMocks.releaseOldAssistant = null;
  });

  test("starts a fresh query after interrupt failure to avoid stale old-turn response", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    const firstTurn = session.stream("first prompt");
    await firstTurn.next();

    const secondTurnPromise = collectUntilTerminal(session.stream("second prompt"));
    await Promise.resolve();
    sdkMocks.releaseOldAssistant?.();

    const secondTurnEvents = await secondTurnPromise;
    const secondAssistantText = collectAssistantText(secondTurnEvents);

    expect(sdkMocks.query).toHaveBeenCalledTimes(2);
    expect(secondAssistantText).toContain("NEW_TURN_RESPONSE");
    expect(secondAssistantText).not.toContain("OLD_TURN_RESPONSE");

    await firstTurn.return?.();
    await session.close();
  });
});
