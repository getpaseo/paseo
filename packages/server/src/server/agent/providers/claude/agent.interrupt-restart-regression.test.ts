import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

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

  scriptedQuery.emit({
    type: "system",
    subtype: "init",
    session_id: params.sessionId,
    permissionMode: "default",
    model: "opus",
  });

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

    scriptedQuery.emit({
      type: "system",
      subtype: "init",
      session_id: "interrupt-abort-recovery-session",
      permissionMode: "default",
      model: "opus",
    });

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

test("creates an autonomous live turn when assistant output arrives without a foreground run", async () => {
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
