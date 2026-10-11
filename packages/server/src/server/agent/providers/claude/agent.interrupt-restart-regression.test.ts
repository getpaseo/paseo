import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

type TurnStart = Awaited<ReturnType<AgentSession["startTurn"]>>;

interface QueryMock {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  cancelAsyncMessage: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
}

interface PromptRecord {
  text: string;
  uuid: string | null;
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  next: () => Promise<IteratorResult<T, void>>;
  end: () => void;
}

type ScriptedQuery = QueryMock & {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  prompts: PromptRecord[];
};

type PromptHandler = (input: {
  prompt: Record<string, unknown>;
  promptRecord: PromptRecord;
  query: ScriptedQuery;
}) => void | Promise<void>;

const queryFactory = vi.fn();

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let ended = false;

  return {
    push(value) {
      if (ended) {
        return;
      }
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }
      items.push(value);
    },
    async next() {
      const value = items.shift();
      if (value !== undefined) {
        return { value, done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return await new Promise<IteratorResult<T, void>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    end() {
      ended = true;
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        resolve?.({ value: undefined, done: true });
      }
    },
  };
}

function buildUsage() {
  return {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  };
}

/** Claude opening a turn of its own. Every main-session turn starts with one. */
function buildTurnInit(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    permissionMode: "default",
    model: "opus",
  };
}

function buildSuccessResult(sessionId: string) {
  return {
    type: "result",
    subtype: "success",
    usage: buildUsage(),
    total_cost_usd: 0,
    session_id: sessionId,
  };
}

function extractPromptText(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function createScriptedQuery(params: {
  prompt: AsyncIterable<unknown>;
  sessionId: string;
  handlePrompt?: PromptHandler;
}): ScriptedQuery {
  const output = createAsyncQueue<Record<string, unknown>>();
  const prompts: PromptRecord[] = [];

  const scriptedQuery = {
    next: vi.fn(() => output.next()),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      output.end();
    }),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    cancelAsyncMessage: vi.fn(async () => true),
    emit: (message: Record<string, unknown>) => {
      output.push(message);
    },
    end: () => {
      output.end();
    },
    prompts,
    [Symbol.asyncIterator]() {
      return this;
    },
  } satisfies ScriptedQuery;

  scriptedQuery.emit(buildTurnInit(params.sessionId));

  void (async () => {
    for await (const prompt of params.prompt) {
      const promptMessage = prompt as Record<string, unknown>;
      const promptRecord = {
        text: extractPromptText(promptMessage),
        uuid: typeof promptMessage.uuid === "string" ? promptMessage.uuid : null,
      };
      prompts.push(promptRecord);
      await params.handlePrompt?.({
        prompt: promptMessage,
        promptRecord,
        query: scriptedQuery,
      });
    }
  })();

  return scriptedQuery;
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
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

/** Pulls the stream forward without closing it, so the caller can keep reading afterwards. */
async function consumeUntil(
  stream: AsyncGenerator<AgentStreamEvent>,
  matches: (event: AgentStreamEvent) => boolean,
): Promise<void> {
  while (true) {
    const next = await stream.next();
    if (next.done) throw new Error("Stream ended before the expected event");
    if (matches(next.value)) return;
  }
}

function collectAssistantText(events: AgentStreamEvent[]): string {
  return events
    .flatMap((event) => {
      if (event.type !== "timeline" || event.item.type !== "assistant_message") {
        return [];
      }
      return [event.item.text];
    })
    .join("");
}

function subscribeToEvents(session: {
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
}) {
  const queue = createAsyncQueue<AgentStreamEvent>();
  const unsubscribe = session.subscribe((event) => {
    queue.push(event);
  });

  return {
    next: () => queue.next(),
    close: () => {
      unsubscribe();
      queue.end();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const intervalMs = options?.intervalMs ?? 5;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Paseo interrupts Claude only while a main-session turn is in flight, which it learns from the
 * init. The pump asks for its next frame only after routing the last one, so a second next() call
 * proves the init was read.
 */
async function waitForInitRouted(
  query: () => { next: ReturnType<typeof vi.fn> } | null | undefined,
) {
  await waitFor(() => (query()?.next.mock.calls.length ?? 0) >= 2);
}

function buildCommandLifecycle(commandUuid: string | null | undefined, state: string) {
  return { type: "command_lifecycle", command_uuid: commandUuid, state };
}

afterEach(() => {
  queryFactory.mockReset();
});

test("interrupt only calls query.interrupt and leaves the query open", async () => {
  const logger = createTestLogger();
  const queries: ScriptedQuery[] = [];

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({
      prompt,
      sessionId: "interrupt-keep-query-session",
    });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  await firstTurn.next();
  await waitFor(() => queries[0]?.prompts.length === 1);
  await waitForInitRouted(() => queries[0]);

  await session.interrupt();
  await waitFor(() => queries[0]?.interrupt.mock.calls.length === 1);

  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queries[0]?.return).not.toHaveBeenCalled();

  const firstTurnEvents = await collectUntilTerminal(firstTurn);
  expect(firstTurnEvents.find((event) => event.type === "turn_canceled")).toMatchObject({
    type: "turn_canceled",
    provider: "claude",
    reason: "Interrupted",
  });

  await session.close();
});

async function startSteeredTurn(sessionId: string): Promise<{
  session: AgentSession;
  query: () => ScriptedQuery | null;
  turn: AsyncGenerator<AgentStreamEvent>;
}> {
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({ prompt, sessionId });
    return query;
  });

  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  const turn = streamSession(session, "original running prompt");
  const start = await turn.next();
  if (!start.value || start.value.type !== "turn_started" || !start.value.turnId) {
    throw new Error("Expected the original Claude turn to start");
  }
  await waitFor(() => query?.prompts.length === 1);
  await waitForInitRouted(() => query);

  const steered = await session.steerActiveTurn!("queued steer", {
    expectedTurnId: start.value.turnId,
    clientMessageId: "steer-client",
  });
  expect(steered).toEqual({ status: "accepted" });
  await waitFor(() => query?.prompts.length === 2);

  return { session, query: () => query, turn };
}

test("interrupt discards a queued steer so it cannot resume the stopped turn", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-discard-session");

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).toHaveBeenCalledWith(query()?.prompts[1]?.uuid);
  expect(await collectUntilTerminal(turn)).toContainEqual(
    expect.objectContaining({ type: "turn_canceled" }),
  );

  // Nothing is queued any more, so a second interrupt has no steer left to discard.
  query()?.cancelAsyncMessage.mockClear();
  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 2);
  expect(query()?.cancelAsyncMessage).not.toHaveBeenCalled();

  await session.close();
});

test("interrupt still stops the turn when Claude has already dequeued the steer", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-declined-session");
  query()?.cancelAsyncMessage.mockResolvedValue(false);

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).toHaveBeenCalledWith(query()?.prompts[1]?.uuid);
  expect(await collectUntilTerminal(turn)).toContainEqual(
    expect.objectContaining({ type: "turn_canceled" }),
  );

  await session.close();
});

test("a steer Claude has already read is no longer discardable on interrupt", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-completed-session");

  query()?.emit(buildCommandLifecycle(query()?.prompts[0]?.uuid, "started"));
  query()?.emit(buildCommandLifecycle(query()?.prompts[1]?.uuid, "completed"));
  // Frames are translated in order, so the marker landing proves the lifecycle frame was read.
  query()?.emit({ type: "assistant", message: { content: "STEER_READ" } });
  await consumeUntil(turn, (event) => collectAssistantText([event]).includes("STEER_READ"));

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).not.toHaveBeenCalled();
  await collectUntilTerminal(turn);
  await session.close();
});

test("a steer Claude cancelled is no longer withdrawn on interrupt", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-cancelled-session");

  query()?.emit(buildCommandLifecycle(query()?.prompts[0]?.uuid, "started"));
  // "cancelled" is terminal: API errors, interrupts and "now" pre-emption all end a message.
  query()?.emit(buildCommandLifecycle(query()?.prompts[1]?.uuid, "cancelled"));
  query()?.emit({ type: "assistant", message: { content: "STEER_CANCELLED" } });
  await consumeUntil(turn, (event) => collectAssistantText([event]).includes("STEER_CANCELLED"));

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).not.toHaveBeenCalled();
  await collectUntilTerminal(turn);
  await session.close();
});

function buildStoppedTaskNotification(sessionId: string) {
  return {
    type: "system",
    subtype: "task_notification",
    uuid: "task-notification-1",
    task_id: "task-slow",
    status: "stopped",
    summary: "Sleep 5 seconds",
    session_id: sessionId,
  };
}

function buildAbortedResult(sessionId: string) {
  return {
    type: "result",
    subtype: "error_during_execution",
    errors: ["Request was aborted."],
    session_id: sessionId,
  };
}

function buildRejectedToolResult(sessionId: string) {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_slow",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
        },
      ],
    },
    uuid: "rejected-tool-result-1",
    session_id: sessionId,
  };
}

async function startInterruptedToolTurn(sessionId: string): Promise<{
  session: AgentSession;
  query: () => ScriptedQuery | null;
  observed: AgentStreamEvent[];
  canceledIndex: number;
  unsubscribe: () => void;
}> {
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({
      prompt,
      sessionId,
      async handlePrompt({ promptRecord, query: scripted }) {
        if (promptRecord.text !== "run the slow tool") {
          return;
        }
        scripted.emit({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "toolu_slow", name: "Bash", input: { command: "sleep 5" } },
            ],
          },
          session_id: sessionId,
        });
      },
    });
    return query;
  });

  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  const observed: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    observed.push(event);
  });

  const turn = streamSession(session, "run the slow tool");
  await turn.next();
  await waitFor(() => query?.prompts.length === 1);
  await waitForInitRouted(() => query);

  await session.interrupt();
  await collectUntilTerminal(turn);

  const canceledIndex = observed.findIndex((event) => event.type === "turn_canceled");
  expect(canceledIndex).toBeGreaterThanOrEqual(0);

  return { session, query: () => query, observed, canceledIndex, unsubscribe };
}

/**
 * Claude keeps reporting on the request it was told to kill: the notification for the tool it just
 * stopped, the aborted result, then the tool rejection. None of that is new work, so none of it may
 * put the agent back into a running turn.
 */
test("trailing output from an interrupted request does not start a turn", async () => {
  const sessionId = "interrupt-window-session";
  const { session, query, observed, canceledIndex, unsubscribe } =
    await startInterruptedToolTurn(sessionId);

  query()?.emit(buildStoppedTaskNotification(sessionId));
  query()?.emit(buildAbortedResult(sessionId));
  query()?.emit(buildRejectedToolResult(sessionId));

  // Frames are translated in order, so the rejection landing proves the two before it were read.
  await waitFor(() =>
    observed.some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.callId === "toolu_slow" &&
        event.item.status === "failed",
    ),
  );
  unsubscribe();

  expect(
    observed.slice(canceledIndex + 1).filter((event) => event.type === "turn_started"),
  ).toEqual([]);

  await session.close();
});

test("Claude can still wake into an autonomous turn once the interrupted request has settled", async () => {
  const sessionId = "interrupt-window-then-wake-session";
  const { session, query, observed, canceledIndex, unsubscribe } =
    await startInterruptedToolTurn(sessionId);

  query()?.emit(buildStoppedTaskNotification(sessionId));
  query()?.emit(buildAbortedResult(sessionId));
  query()?.emit(buildTurnInit(sessionId));
  query()?.emit({
    type: "assistant",
    message: { content: "AUTONOMOUS_WAKE_RESPONSE" },
    session_id: sessionId,
  });
  query()?.emit(buildSuccessResult(sessionId));

  await waitFor(() =>
    observed.slice(canceledIndex + 1).some((event) => event.type === "turn_completed"),
  );
  unsubscribe();

  const afterCancel = observed.slice(canceledIndex + 1);
  expect(afterCancel.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(collectAssistantText(afterCancel)).toContain("AUTONOMOUS_WAKE_RESPONSE");

  await session.close();
});

test("reuses the existing query after interrupt before starting the next prompt", async () => {
  const logger = createTestLogger();
  const queries: ScriptedQuery[] = [];

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({
      prompt,
      sessionId: "interrupt-reuse-query-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text !== "second prompt") {
          return;
        }
        query.emit({
          type: "assistant",
          message: { content: "SECOND_PROMPT_RESPONSE" },
          session_id: "interrupt-reuse-query-session",
        });
        query.emit(buildSuccessResult("interrupt-reuse-query-session"));
      },
    });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  await firstTurn.next();
  await waitFor(() => queries[0]?.prompts.length === 1);
  await waitForInitRouted(() => queries[0]);

  await session.interrupt();
  await collectUntilTerminal(firstTurn);

  const secondTurnEvents = await collectUntilTerminal(streamSession(session, "second prompt"));

  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queries[0]?.prompts.map((prompt) => prompt.text)).toEqual([
    "first prompt",
    "second prompt",
  ]);
  expect(queries[0]?.interrupt).toHaveBeenCalledTimes(1);
  expect(queries[0]?.return).not.toHaveBeenCalled();
  expect(collectAssistantText(secondTurnEvents)).toContain("SECOND_PROMPT_RESPONSE");

  await session.close();
});

test("emits an assistant system notice when Claude changes session id mid-turn", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "claude-original-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text !== "trigger session switch") {
          return;
        }
        query.emit({
          type: "assistant",
          message: { content: "Claude kept working." },
          session_id: "claude-provider-switched-session",
        });
        query.emit(buildSuccessResult("claude-provider-switched-session"));
      },
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const events = await collectUntilTerminal(streamSession(session, "trigger session switch"));
  const assistantMessages = events.flatMap((event) => {
    if (event.type !== "timeline" || event.item.type !== "assistant_message") {
      return [];
    }
    return [event.item.text];
  });

  expect(session.id).toBe("claude-provider-switched-session");
  expect(assistantMessages).toContain("Claude kept working.");
  expect(assistantMessages).toContain(
    "Claude switched to a new session: claude-original-session -> claude-provider-switched-session",
  );

  await session.close();
});

test("recovers when the query pump sees a single interrupt abort before the next prompt", async () => {
  const logger = createTestLogger();
  const output = createAsyncQueue<Record<string, unknown>>();
  const prompts: PromptRecord[] = [];
  let throwAbortOnNext = false;
  let queryRef: Pick<ScriptedQuery, "next"> | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = {
      next: vi.fn(async () => {
        if (throwAbortOnNext) {
          throwAbortOnNext = false;
          throw new Error("Request was aborted.");
        }
        return output.next();
      }),
      interrupt: vi.fn(async () => {
        throwAbortOnNext = true;
      }),
      return: vi.fn(async () => {
        output.end();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      emit: (message: Record<string, unknown>) => {
        output.push(message);
      },
      end: () => {
        output.end();
      },
      prompts,
      [Symbol.asyncIterator]() {
        return this;
      },
    } satisfies ScriptedQuery;

    queryRef = scriptedQuery;
    scriptedQuery.emit(buildTurnInit("interrupt-abort-recovery-session"));

    void (async () => {
      for await (const promptMessage of prompt) {
        const record = promptMessage as Record<string, unknown>;
        const promptRecord = {
          text: extractPromptText(record),
          uuid: typeof record.uuid === "string" ? record.uuid : null,
        };
        prompts.push(promptRecord);

        if (promptRecord.text !== "second prompt") {
          continue;
        }

        output.push({
          type: "assistant",
          message: { content: "SECOND_PROMPT_RESPONSE" },
          session_id: "interrupt-abort-recovery-session",
        });
        output.push(buildSuccessResult("interrupt-abort-recovery-session"));
      }
    })();

    return scriptedQuery;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  await firstTurn.next();
  await waitForInitRouted(() => queryRef);
  await session.interrupt();
  await collectUntilTerminal(firstTurn);

  const secondTurnEvents = await collectUntilTerminal(streamSession(session, "second prompt"));

  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(prompts.map((prompt) => prompt.text)).toEqual(["first prompt", "second prompt"]);
  expect(collectAssistantText(secondTurnEvents)).toContain("SECOND_PROMPT_RESPONSE");
  expect(secondTurnEvents.some((event) => event.type === "turn_completed")).toBe(true);

  await session.close();
});

test("stale abort result after replacement start does not poison the new foreground turn", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "interrupt-stale-result-session",
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  const firstStarted = await firstTurn.next();
  await waitFor(() => queryRef?.prompts.length === 1);
  await waitForInitRouted(() => queryRef);

  await session.interrupt();
  const firstTurnEvents = [firstStarted.value!, ...(await collectUntilTerminal(firstTurn))];
  expect(firstTurnEvents.some((event) => event.type === "turn_canceled")).toBe(true);

  const observedSecondTurnEvents: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    observedSecondTurnEvents.push(event);
  });

  const secondTurn = streamSession(session, "second prompt");
  const secondStarted = await secondTurn.next();
  await waitFor(() => queryRef?.prompts.length === 2);

  queryRef?.emit({
    type: "result",
    subtype: "error_during_execution",
    errors: ["Request was aborted."],
    session_id: "interrupt-stale-result-session",
  });
  queryRef?.emit({
    type: "assistant",
    message: { content: "SECOND_PROMPT_RESPONSE" },
    session_id: "interrupt-stale-result-session",
  });
  queryRef?.emit(buildSuccessResult("interrupt-stale-result-session"));

  const secondTurnEvents = [secondStarted.value!, ...(await collectUntilTerminal(secondTurn))];
  unsubscribe();

  expect(secondTurnEvents.some((event) => event.type === "turn_failed")).toBe(false);
  expect(secondTurnEvents.some((event) => event.type === "turn_canceled")).toBe(false);
  expect(secondTurnEvents.some((event) => event.type === "turn_completed")).toBe(true);
  expect(collectAssistantText(secondTurnEvents)).toContain("SECOND_PROMPT_RESPONSE");
  expect(observedSecondTurnEvents.filter((event) => event.type === "turn_started").length).toBe(1);
  expect(
    observedSecondTurnEvents.some(
      (event) => event.type === "turn_failed" || event.type === "turn_canceled",
    ),
  ).toBe(false);

  await session.close();
});

test("creates an autonomous live turn when Claude starts a turn without a foreground run", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "autonomous-live-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text !== "seed prompt") {
          return;
        }
        query.emit({
          type: "assistant",
          message: { content: "SEED_RESPONSE" },
          session_id: "autonomous-live-session",
        });
        query.emit(buildSuccessResult("autonomous-live-session"));
      },
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  await collectUntilTerminal(streamSession(session, "seed prompt"));

  const subscribedEvents = subscribeToEvents(session);
  queryRef?.emit(buildTurnInit("autonomous-live-session"));
  queryRef?.emit({
    type: "assistant",
    message: { content: "AUTONOMOUS_WAKE_RESPONSE" },
    session_id: "autonomous-live-session",
  });
  queryRef?.emit(buildSuccessResult("autonomous-live-session"));

  const started = await subscribedEvents.next();
  const timeline = await subscribedEvents.next();
  const completed = await subscribedEvents.next();

  expect(started.value).toMatchObject({ type: "turn_started", provider: "claude" });
  expect(timeline.value).toMatchObject({
    type: "timeline",
    provider: "claude",
    item: {
      type: "assistant_message",
      text: "AUTONOMOUS_WAKE_RESPONSE",
    },
  });
  expect(completed.value).toMatchObject({
    type: "turn_completed",
    provider: "claude",
  });

  subscribedEvents.close();
  await session.close();
});

test("steers an autonomous turn through its existing query without restarting it", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "autonomous-steer-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text === "seed prompt") {
          query.emit({
            type: "assistant",
            message: { content: "SEED_RESPONSE" },
            session_id: "autonomous-steer-session",
          });
          query.emit(buildSuccessResult("autonomous-steer-session"));
          return;
        }
        if (promptRecord.text === "steer prompt") {
          query.emit({
            type: "assistant",
            message: { content: "STEERED_RESPONSE" },
            session_id: "autonomous-steer-session",
          });
          query.emit(buildSuccessResult("autonomous-steer-session"));
        }
      },
    });
    return queryRef;
  });

  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  await collectUntilTerminal(streamSession(session, "seed prompt"));
  const autonomousEvents = subscribeToEvents(session);
  queryRef?.emit(buildTurnInit("autonomous-steer-session"));
  queryRef?.emit({
    type: "assistant",
    message: { content: "AUTONOMOUS_RESPONSE" },
    session_id: "autonomous-steer-session",
  });
  const autonomousStart = await autonomousEvents.next();
  const autonomousTimeline = await autonomousEvents.next();
  const autonomousTurnId = autonomousStart.value?.turnId;
  expect(autonomousTurnId).toBeTruthy();

  const steer = await session.steerActiveTurn!("steer prompt", {
    expectedTurnId: autonomousTurnId!,
    clientMessageId: "steer-client",
  });
  const steeredTimeline = await autonomousEvents.next();
  const completion = await autonomousEvents.next();

  expect(steer).toEqual({ status: "accepted" });
  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queryRef?.interrupt).not.toHaveBeenCalled();
  expect(queryRef?.prompts.map((prompt) => prompt.text)).toEqual(["seed prompt", "steer prompt"]);
  expect(autonomousTimeline.value).toMatchObject({ turnId: autonomousTurnId });
  expect(steeredTimeline.value).toMatchObject({
    type: "timeline",
    turnId: autonomousTurnId,
    item: { type: "assistant_message", text: "STEERED_RESPONSE" },
  });
  expect(completion.value).toMatchObject({ type: "turn_completed", turnId: autonomousTurnId });
  expect(
    [autonomousStart.value, autonomousTimeline.value, steeredTimeline.value, completion.value].map(
      (event) => event?.turnId,
    ),
  ).toEqual([autonomousTurnId, autonomousTurnId, autonomousTurnId, autonomousTurnId]);

  autonomousEvents.close();
  await session.close();
});

test("auto-completes an open autonomous turn when a foreground prompt starts", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "autonomous-handoff-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text === "seed prompt") {
          query.emit({
            type: "assistant",
            message: { content: "SEED_RESPONSE" },
            session_id: "autonomous-handoff-session",
          });
          query.emit(buildSuccessResult("autonomous-handoff-session"));
          return;
        }

        if (promptRecord.text === "foreground prompt") {
          query.emit({
            type: "assistant",
            message: { content: "FOREGROUND_RESPONSE" },
            session_id: "autonomous-handoff-session",
          });
          query.emit(buildSuccessResult("autonomous-handoff-session"));
        }
      },
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  await collectUntilTerminal(streamSession(session, "seed prompt"));

  const subscribedEvents = subscribeToEvents(session);
  queryRef?.emit(buildTurnInit("autonomous-handoff-session"));
  queryRef?.emit({
    type: "assistant",
    message: { content: "BACKGROUND_ONLY_RESPONSE" },
    session_id: "autonomous-handoff-session",
  });

  const autonomousStart = await subscribedEvents.next();
  const autonomousTimeline = await subscribedEvents.next();
  const foregroundEvents = await collectUntilTerminal(streamSession(session, "foreground prompt"));
  const autonomousComplete = await subscribedEvents.next();

  expect(autonomousStart.value).toMatchObject({
    type: "turn_started",
    provider: "claude",
  });
  expect(autonomousTimeline.value).toMatchObject({
    type: "timeline",
    provider: "claude",
    item: {
      type: "assistant_message",
      text: "BACKGROUND_ONLY_RESPONSE",
    },
  });
  expect(autonomousComplete.value).toMatchObject({
    type: "turn_completed",
    provider: "claude",
  });
  expect(foregroundEvents.some((event) => event.type === "turn_completed")).toBe(true);
  expect(collectAssistantText(foregroundEvents)).toContain("FOREGROUND_RESPONSE");
  expect(
    [autonomousStart.value, autonomousTimeline.value, autonomousComplete.value].some(
      (event) => event?.type === "turn_canceled",
    ),
  ).toBe(false);
  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queryRef?.prompts.map((prompt) => prompt.text)).toEqual([
    "seed prompt",
    "foreground prompt",
  ]);

  subscribedEvents.close();
  await session.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** A session whose withdrawals and binary lookup the test controls. */
async function createControlledSession(options: {
  withdrawal?: () => Promise<boolean>;
  resolveBinary?: () => Promise<string>;
}): Promise<{
  session: AgentSession;
  query: () => ScriptedQuery | null;
  queries: ScriptedQuery[];
}> {
  let query: ScriptedQuery | null = null;
  const queries: ScriptedQuery[] = [];
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({ prompt, sessionId: "controlled-session" });
    if (options.withdrawal) query.cancelAsyncMessage.mockImplementation(options.withdrawal);
    queries.push(query);
    return query;
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: options.resolveBinary ?? (async () => "/test/claude/bin"),
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  return { session, query: () => query, queries };
}

test("a refused withdrawal that answers late interrupts A before B is admitted, never B", async () => {
  const withdrawal = deferred<boolean>();
  const { session, query } = await createControlledSession({
    withdrawal: () => withdrawal.promise,
  });

  await session.startTurn("A");
  await waitFor(() => query()?.prompts.length === 1);
  await session.interrupt();

  const second = session.startTurn("B");
  await settleMicrotasks();
  expect(query()?.prompts).toHaveLength(1);
  expect(query()?.interrupt).not.toHaveBeenCalled();

  withdrawal.resolve(false);
  await second;
  expect(query()?.interrupt).toHaveBeenCalledTimes(1);
  await waitFor(() => query()?.prompts.length === 2);
  query()?.emit(buildCommandLifecycle(query()?.prompts[1]?.uuid, "started"));
  expect(query()?.interrupt).toHaveBeenCalledTimes(1);

  await session.close();
});

test("a confirmed withdrawal that answers late admits B without an interrupt", async () => {
  const withdrawal = deferred<boolean>();
  const { session, query } = await createControlledSession({
    withdrawal: () => withdrawal.promise,
  });

  await session.startTurn("A");
  await waitFor(() => query()?.prompts.length === 1);
  await session.interrupt();
  const second = session.startTurn("B");
  await settleMicrotasks();

  withdrawal.resolve(true);
  await second;
  expect(query()?.interrupt).not.toHaveBeenCalled();
  await waitFor(() => query()?.prompts.length === 2);

  await session.close();
});

test("an unanswered withdrawal is bounded: the interrupt still goes out and B is admitted", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { session, query } = await createControlledSession({
      withdrawal: () => new Promise<boolean>(() => undefined),
    });
    await session.startTurn("A");
    await vi.advanceTimersByTimeAsync(0);
    expect(query()?.prompts).toHaveLength(1);
    await session.interrupt();
    const second = session.startTurn("B");
    await vi.advanceTimersByTimeAsync(0);
    expect(query()?.interrupt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(query()?.interrupt).toHaveBeenCalledTimes(1);
    await session.close();
  } finally {
    vi.useRealTimers();
  }
});

test("closing with A's withdrawal unanswered retires the query without admitting another turn", async () => {
  const { session, query } = await createControlledSession({
    withdrawal: () => new Promise<boolean>(() => undefined),
  });
  await session.startTurn("A");
  await waitFor(() => query()?.prompts.length === 1);
  await session.interrupt();

  await session.close();
  expect(query()?.close).toHaveBeenCalledTimes(1);
  expect(query()?.return).toHaveBeenCalledTimes(1);
  expect(query()?.prompts.map((prompt) => prompt.text)).toEqual(["A"]);
  await expect(session.startTurn("B")).rejects.toThrow("Claude session is closed");
});

test("Stop while the binary is still resolving withdraws the prompt by never sending it", async () => {
  const binary = deferred<string>();
  const { session, query } = await createControlledSession({ resolveBinary: () => binary.promise });

  const starting = session.startTurn("A");
  await settleMicrotasks();
  await session.interrupt();
  binary.resolve("/test/claude/bin");

  await starting;
  expect(query()?.prompts ?? []).toHaveLength(0);
  await session.close();
});

test("Stop while B waits behind A's cancellation cancels B and never pushes it", async () => {
  const withdrawal = deferred<boolean>();
  const { session, query } = await createControlledSession({
    withdrawal: () => withdrawal.promise,
  });
  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type.startsWith("turn_")) events.push(event.type);
  });

  await session.startTurn("A");
  await waitFor(() => query()?.prompts.length === 1);
  await waitForInitRouted(query);
  await session.interrupt();
  const second = session.startTurn("B");
  await settleMicrotasks();

  await session.interrupt();
  expect(events).toEqual(["turn_started", "turn_canceled", "turn_started", "turn_canceled"]);

  withdrawal.resolve(false);
  await second;
  await settleMicrotasks();
  expect(query()?.prompts.map((prompt) => prompt.text)).toEqual(["A"]);
  expect(query()?.interrupt).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["turn_started", "turn_canceled", "turn_started", "turn_canceled"]);

  await session.close();
});

test("two Stops while B waits behind A's cancellation cancel B once; the second only interrupts Claude's running turn", async () => {
  const withdrawal = deferred<boolean>();
  const { session, query } = await createControlledSession({
    withdrawal: () => withdrawal.promise,
  });
  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type.startsWith("turn_")) events.push(event.type);
  });

  await session.startTurn("A");
  await waitFor(() => query()?.prompts.length === 1);
  await waitForInitRouted(query);
  await session.interrupt();
  const second = session.startTurn("B");
  await settleMicrotasks();

  await session.interrupt();
  expect(query()?.interrupt).not.toHaveBeenCalled();
  // Nothing of ours is pending any more, but Claude's main turn is still running: this Stop is
  // a plain native interrupt of that turn, never of B, which was never pushed.
  await session.interrupt();
  expect(query()?.interrupt).toHaveBeenCalledTimes(1);
  expect(query()?.prompts.map((prompt) => prompt.text)).toEqual(["A"]);

  withdrawal.resolve(false);
  await second;
  await settleMicrotasks();
  expect(query()?.prompts.map((prompt) => prompt.text)).toEqual(["A"]);
  expect(query()?.interrupt).toHaveBeenCalledTimes(2);
  expect(events).toEqual(["turn_started", "turn_canceled", "turn_started", "turn_canceled"]);

  await session.startTurn("C");
  await waitFor(() => query()?.prompts.length === 2);
  query()?.emit(buildCommandLifecycle(query()?.prompts[1]?.uuid, "started"));

  await session.close();
});

type WithdrawalAnswer = "confirm" | "refuse" | "hang";
type LateFrames = "none" | "started" | "started+result";
type MidOrder = "frames-first" | "stops-first";

interface PendingReplacementSchedule {
  withdrawal: WithdrawalAnswer;
  frames: LateFrames;
  stops: 0 | 1 | 2;
  close: boolean;
  startC: boolean;
  order: MidOrder;
}

const WITHDRAWAL_ANSWERS: WithdrawalAnswer[] = ["confirm", "refuse", "hang"];
const LATE_FRAMES: LateFrames[] = ["none", "started", "started+result"];
const STOP_COUNTS: Array<0 | 1 | 2> = [0, 1, 2];
const MID_ORDERS: MidOrder[] = ["frames-first", "stops-first"];

type MidPhaseVariant = Pick<PendingReplacementSchedule, "close" | "startC" | "order">;

function enumerateMidPhaseVariants(): MidPhaseVariant[] {
  const variants: MidPhaseVariant[] = [];
  for (const close of [false, true]) {
    for (const startC of [false, true]) {
      for (const order of MID_ORDERS) {
        variants.push({ close, startC, order });
      }
    }
  }
  return variants;
}

function enumeratePendingReplacementSchedules(): PendingReplacementSchedule[] {
  const schedules: PendingReplacementSchedule[] = [];
  for (const withdrawal of WITHDRAWAL_ANSWERS) {
    for (const frames of LATE_FRAMES) {
      for (const stops of STOP_COUNTS) {
        for (const variant of enumerateMidPhaseVariants()) {
          schedules.push({ withdrawal, frames, stops, ...variant });
        }
      }
    }
  }
  return schedules;
}

function describeSchedule(schedule: PendingReplacementSchedule): string {
  return [
    `withdrawal=${schedule.withdrawal}`,
    `frames=${schedule.frames}`,
    `stops=${schedule.stops}`,
    schedule.close ? "close" : "open",
    schedule.startC ? "startC" : "noC",
    schedule.order,
  ].join(" ");
}

/** Drains microtasks and the pump's async hops without depending on faked timers. */
async function settleMicrotasks(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface TurnEventRecord {
  type: string;
  turnId: string | undefined;
}

interface PendingReplacementRun {
  schedule: PendingReplacementSchedule;
  session: AgentSession;
  live: ScriptedQuery;
  events: TurnEventRecord[];
  promptsAtInterrupt: string[][];
  first: TurnStart;
  secondStart: Promise<TurnStart>;
  closePromise: Promise<void> | null;
  thirdStart: Promise<TurnStart | null> | null;
  thirdRejected: () => string | null;
}

function promptTexts(live: ScriptedQuery): string[] {
  return live.prompts.map((prompt) => prompt.text);
}

/** A stopped, un-acknowledged A with its withdrawal held, and B waiting behind it. */
async function arrangePendingReplacement(
  schedule: PendingReplacementSchedule,
  withdrawal: Promise<boolean>,
): Promise<PendingReplacementRun> {
  const { session, query } = await createControlledSession({ withdrawal: () => withdrawal });
  const events: TurnEventRecord[] = [];
  session.subscribe((event) => {
    if (event.type.startsWith("turn_")) {
      events.push({ type: event.type, turnId: (event as { turnId?: string }).turnId });
    }
  });
  const promptsAtInterrupt: string[][] = [];
  const first = await session.startTurn("A");
  await settleMicrotasks();
  const live = query();
  if (!live) throw new Error("query was not created");
  live.interrupt.mockImplementation(async () => {
    promptsAtInterrupt.push(promptTexts(live));
  });
  expect(promptTexts(live)).toEqual(["A"]);
  expect(live.next.mock.calls.length).toBeGreaterThanOrEqual(2);

  await session.interrupt();
  const secondStart = session.startTurn("B");
  await settleMicrotasks();
  expect(promptTexts(live)).toEqual(["A"]);
  return {
    schedule,
    session,
    live,
    events,
    promptsAtInterrupt,
    first,
    secondStart,
    closePromise: null,
    thirdStart: null,
    thirdRejected: () => null,
  };
}

async function deliverLateFrames(run: PendingReplacementRun): Promise<void> {
  if (run.schedule.frames === "none") return;
  run.live.emit(buildCommandLifecycle(run.live.prompts[0]?.uuid ?? null, "started"));
  if (run.schedule.frames === "started+result") {
    run.live.emit(buildSuccessResult("controlled-session"));
  }
  await settleMicrotasks();
}

async function deliverStops(run: PendingReplacementRun): Promise<void> {
  for (let index = 0; index < run.schedule.stops; index += 1) {
    await run.session.interrupt();
    await settleMicrotasks();
  }
}

/** Everything that happens while B is still waiting: late A frames, Stops, close, a competing C. */
async function actWhileReplacementPends(run: PendingReplacementRun): Promise<void> {
  if (run.schedule.order === "frames-first") {
    await deliverLateFrames(run);
    await deliverStops(run);
  } else {
    await deliverStops(run);
    await deliverLateFrames(run);
  }
  if (run.schedule.close) {
    run.closePromise = run.session.close();
    await settleMicrotasks();
  }
  if (run.schedule.startC) {
    let rejected: string | null = null;
    run.thirdStart = run.session.startTurn("C").catch((error: unknown) => {
      rejected = error instanceof Error ? error.message : String(error);
      return null;
    });
    run.thirdRejected = () => rejected;
    await settleMicrotasks();
  }
  expect(promptTexts(run.live)).toEqual(["A"]);
}

async function releaseWithdrawal(
  run: PendingReplacementRun,
  withdrawal: { resolve: (value: boolean) => void },
): Promise<void> {
  if (run.schedule.withdrawal === "hang") {
    await vi.advanceTimersByTimeAsync(3_000);
  } else {
    withdrawal.resolve(run.schedule.withdrawal === "confirm");
  }
  await settleMicrotasks();
  await vi.advanceTimersByTimeAsync(0);
  await settleMicrotasks();
  if (run.closePromise) {
    await vi.advanceTimersByTimeAsync(6_000);
    await run.closePromise;
  }
}

async function assertPushesAndInterrupts(
  run: PendingReplacementRun,
  bCancelled: boolean,
): Promise<void> {
  const expectedPushed = ["A"];
  if (!bCancelled) expectedPushed.push("B");
  if (run.schedule.startC && bCancelled && !run.schedule.close) expectedPushed.push("C");
  expect(promptTexts(run.live)).toEqual(expectedPushed);
  expect(queryFactory).toHaveBeenCalledTimes(1);
  for (const prompts of run.promptsAtInterrupt) {
    expect(prompts).toEqual(["A"]);
  }
}

async function assertReplacementAvailability(
  run: PendingReplacementRun,
  second: TurnStart,
  third: TurnStart | null,
  bCancelled: boolean,
): Promise<void> {
  expect(await run.session.steerActiveTurn?.("steer B", { expectedTurnId: second.turnId })).toEqual(
    {
      status: bCancelled ? "unavailable" : "accepted",
    },
  );
  if (!run.schedule.startC) return;
  if (run.schedule.close || !bCancelled) {
    expect(third).toBeNull();
    expect(run.thirdRejected()).toBe(
      run.schedule.close ? "Claude session is closed" : "A foreground turn is already active",
    );
    return;
  }
  expect(third).not.toBeNull();
  expect(await run.session.steerActiveTurn?.("steer C", { expectedTurnId: third!.turnId })).toEqual(
    {
      status: "accepted",
    },
  );
}

function assertTurnEvents(
  run: PendingReplacementRun,
  second: TurnStart,
  bCancelled: boolean,
): void {
  const byTurn = new Map<string, string[]>();
  for (const event of run.events) {
    const key = event.turnId ?? "?";
    byTurn.set(key, [...(byTurn.get(key) ?? []), event.type]);
  }
  for (const sequence of byTurn.values()) {
    expect(sequence[0]).toBe("turn_started");
    expect(sequence.filter((type) => type === "turn_started")).toHaveLength(1);
    expect(sequence.filter((type) => type !== "turn_started").length).toBeLessThanOrEqual(1);
  }
  expect(byTurn.get(second.turnId) ?? []).toEqual(
    bCancelled ? ["turn_started", "turn_canceled"] : ["turn_started"],
  );
  expect(byTurn.get(run.first.turnId) ?? []).toEqual(["turn_started", "turn_canceled"]);
}

async function runPendingReplacementSchedule(schedule: PendingReplacementSchedule) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const withdrawal = deferred<boolean>();
    const run = await arrangePendingReplacement(schedule, withdrawal.promise);
    await actWhileReplacementPends(run);
    await releaseWithdrawal(run, withdrawal);

    const second = await run.secondStart;
    const third = run.thirdStart ? await run.thirdStart : null;
    await settleMicrotasks();
    const bCancelled = schedule.stops > 0 || schedule.close;

    await assertPushesAndInterrupts(run, bCancelled);
    await assertReplacementAvailability(run, second, third, bCancelled);
    const interruptsAfterPush = run.live.interrupt.mock.calls.length;
    await settleMicrotasks();
    expect(run.live.interrupt.mock.calls.length).toBe(interruptsAfterPush);
    assertTurnEvents(run, second, bCancelled);

    if (!schedule.close) await run.session.close();
  } finally {
    vi.useRealTimers();
  }
}

for (const schedule of enumeratePendingReplacementSchedules()) {
  test(`pending replacement schedule: ${describeSchedule(schedule)}`, async () => {
    await runPendingReplacementSchedule(schedule);
  });
}

test("a retired query's missing-conversation recovery leaves the replacement turn it did not own alone", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const withdrawal = deferred<boolean>();
    const heldReturn = deferred<void>();
    const { session, queries } = await createControlledSession({
      withdrawal: () => withdrawal.promise,
    });
    const events: Array<{ type: string; turnId: string | undefined }> = [];
    session.subscribe((event) => {
      if (event.type.startsWith("turn_")) {
        events.push({ type: event.type, turnId: (event as { turnId?: string }).turnId });
      }
    });

    await session.startTurn("A");
    await settleMicrotasks();
    const retired = queries[0];
    if (!retired) throw new Error("query was not created");
    expect(retired.next.mock.calls.length).toBeGreaterThanOrEqual(2);
    await session.interrupt();
    const secondStart = session.startTurn("B");
    await settleMicrotasks();

    // The recovery's own return of the failed query is what we hold open.
    retired.return.mockImplementationOnce(async () => {
      await heldReturn.promise;
      retired.end();
    });
    retired.emit({
      type: "result",
      subtype: "error_during_execution",
      errors: ["No conversation found with session ID: controlled-session"],
    });
    await settleMicrotasks();
    expect(retired.return).toHaveBeenCalledTimes(1);

    await session.setThinkingOption?.(null);
    withdrawal.resolve(false);
    await settleMicrotasks();
    const second = await secondStart;
    await settleMicrotasks();
    const replacement = queries[1];
    if (!replacement) throw new Error("replacement query was not created");
    expect(queries).toHaveLength(2);
    expect(replacement.prompts.map((prompt) => prompt.text)).toEqual(["B"]);
    replacement.emit(buildCommandLifecycle(replacement.prompts[0]?.uuid, "started"));

    heldReturn.resolve();
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    await settleMicrotasks();

    const bEvents = events.filter((event) => event.turnId === second.turnId).map((e) => e.type);
    expect(bEvents).toEqual(["turn_started"]);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(replacement.return).not.toHaveBeenCalled();
    expect(replacement.interrupt).not.toHaveBeenCalled();
    const competing = await session.startTurn("C").then(
      () => "admitted",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(competing).toBe("A foreground turn is already active");
    expect(await session.steerActiveTurn?.("more", { expectedTurnId: second.turnId })).toEqual({
      status: "accepted",
    });
    await session.interrupt();
    await settleMicrotasks();
    expect(events.filter((event) => event.turnId === second.turnId).map((e) => e.type)).toEqual([
      "turn_started",
      "turn_canceled",
    ]);
    expect(replacement.prompts.map((prompt) => prompt.text)).toEqual(["B", "more"]);

    await session.close();
  } finally {
    vi.useRealTimers();
  }
});

test("close during binary lookup never creates a query after the session closes", async () => {
  const binary = deferred<string>();
  const { session, queries } = await createControlledSession({
    resolveBinary: () => binary.promise,
  });
  const events: string[] = [];
  session.subscribe((event) => {
    if (event.type.startsWith("turn_")) events.push(event.type);
  });
  const starting = session.startTurn("A");
  await settleMicrotasks();
  await session.close();
  binary.resolve("/test/claude/bin");
  await starting;
  expect(queries).toHaveLength(0);
  expect(events).toEqual(["turn_started", "turn_canceled"]);
  await expect(session.listCommands()).rejects.toThrow("Claude session is closed");
  expect(queries).toHaveLength(0);
});
