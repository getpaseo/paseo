import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentSession } from "../../agent-sdk-types.js";

const SESSION_ID = "session-1";

/** Claude Code replies to a turn either with an assistant message or with nothing at all. */
type TurnOutcome = { assistantMessageId: string; subagentMessageId?: string } | "no-response";

function initMessage(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    permissionMode: "default",
    model: "claude-sonnet-4-6",
  };
}

/** Claude Code echoes the user message back under the uuid Paseo minted for it. */
function userEcho(uuid: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    session_id: SESSION_ID,
    message: { role: "user", content: [{ type: "text", text: "prompt" }] },
  };
}

function assistantReply(uuid: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION_ID,
    message: { id: uuid, role: "assistant", content: [{ type: "text", text: "ok" }] },
  };
}

/**
 * A message from a Task subagent. The CLI streams these on the same query as the main
 * conversation, and their uuids live on the subagent's sidechain, not on the session's
 * own message chain, so `forkSession` cannot resolve one.
 */
function subagentReply(uuid: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: "toolu_subagent_1",
    message: { id: uuid, role: "assistant", content: [{ type: "text", text: "subagent work" }] },
  };
}

function successResult(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    uuid: "result-ok",
    session_id: SESSION_ID,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "",
    total_cost_usd: 0,
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    permission_denials: [],
  };
}

/** A turn that dies upstream before the model emits its first token. */
function failedResult(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error_during_execution",
    uuid: "result-failed",
    session_id: SESSION_ID,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    errors: ["upstream gateway returned 503"],
    total_cost_usd: 0,
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
  };
}

interface Conversation {
  queryFactory: ReturnType<typeof vi.fn>;
  /** The uuid Paseo minted for each prompt, in the order the turns ran. */
  userMessageIds: string[];
}

function createConversation(outcomes: TurnOutcome[]): Conversation {
  const userMessageIds: string[] = [];
  const queryFactory = vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const queued: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    const closedRef = { value: false };
    let turnIndex = 0;

    const wake = () => waiters.shift()?.();
    const enqueue = (message: Record<string, unknown>) => {
      queued.push(message);
      wake();
    };

    void (async () => {
      for await (const sent of prompt) {
        const userMessageId = String((sent as { uuid?: unknown }).uuid);
        userMessageIds.push(userMessageId);
        const outcome = outcomes[turnIndex];
        turnIndex += 1;
        if (turnIndex === 1) {
          enqueue(initMessage());
        }
        enqueue(userEcho(userMessageId));
        if (outcome === "no-response" || !outcome) {
          enqueue(failedResult());
          continue;
        }
        enqueue(assistantReply(outcome.assistantMessageId));
        if (outcome.subagentMessageId) {
          enqueue(subagentReply(outcome.subagentMessageId));
        }
        enqueue(successResult());
      }
      closedRef.value = true;
      wake();
    })();

    return {
      next: vi.fn(async () => {
        while (queued.length === 0 && !closedRef.value) {
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
        if (queued.length === 0) {
          return { done: true, value: undefined };
        }
        return { done: false, value: queued.shift() };
      }),
      interrupt: vi.fn(async () => undefined),
      return: vi.fn(async () => {
        closedRef.value = true;
        wake();
        return undefined;
      }),
      close: vi.fn(() => {
        closedRef.value = true;
        wake();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
  return { queryFactory, userMessageIds };
}

async function createSession(
  conversation: Conversation,
  rewindSdk: FakeClaudeSdk,
): Promise<AgentSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: conversation.queryFactory as never,
    resolveBinary: async () => "/test/claude/bin",
    rewindSdk,
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "claude-sonnet-4-6",
  });
}

async function runTurns(session: AgentSession, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    for await (const _ of streamSession(session, `turn ${index + 1}`)) {
      // drain to the terminal event
    }
  }
}

describe("Claude rewind across a turn that produced no response", () => {
  test("forks at the most recent turn that did produce a response", async () => {
    const conversation = createConversation([
      { assistantMessageId: "assistant-1" },
      "no-response",
      { assistantMessageId: "assistant-3" },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 3);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[2] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });

  test("starts a fresh session when no earlier turn produced a response", async () => {
    const conversation = createConversation(["no-response", { assistantMessageId: "assistant-2" }]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 2);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([]);
  });

  test("still forks at the previous turn when every turn produced a response", async () => {
    const conversation = createConversation([
      { assistantMessageId: "assistant-1" },
      { assistantMessageId: "assistant-2" },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 2);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });
});

describe("Claude rewind after a turn whose last assistant message came from a subagent", () => {
  test("forks at the turn's own reply, not at the subagent message", async () => {
    const conversation = createConversation([
      { assistantMessageId: "assistant-1", subagentMessageId: "subagent-1" },
      { assistantMessageId: "assistant-2" },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 2);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });
});
