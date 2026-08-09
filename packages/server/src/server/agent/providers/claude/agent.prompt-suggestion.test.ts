import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

interface AsyncQueue<T> {
  push(value: T): void;
  next(): Promise<IteratorResult<T, void>>;
  end(): void;
}

interface ScriptedQuery {
  emit(message: Record<string, unknown>): void;
  end(): void;
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>, void>;
}

const queryFactory = vi.fn();

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const waiters: Array<(value: IteratorResult<T, void>) => void> = [];
  let ended = false;

  return {
    push(value) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else items.push(value);
    },
    async next() {
      const value = items.shift();
      if (value !== undefined) return { value, done: false };
      if (ended) return { value: undefined, done: true };
      return await new Promise<IteratorResult<T, void>>((resolve) => waiters.push(resolve));
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };
}

function createScriptedQuery(sessionId: string): ScriptedQuery {
  const output = createAsyncQueue<Record<string, unknown>>();
  const query = {
    emit(message: Record<string, unknown>) {
      output.push(message);
    },
    end() {
      output.end();
    },
    next: vi.fn(() => output.next()),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => output.end()),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getContextUsage: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } satisfies ScriptedQuery;
  query.emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    permissionMode: "default",
    model: "opus",
  });
  return query;
}

function successResult(sessionId: string, uuid: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
  };
}

function promptSuggestion(
  sessionId: string,
  uuid: string,
  suggestion: string,
): Record<string, unknown> {
  return {
    type: "prompt_suggestion",
    session_id: sessionId,
    uuid,
    suggestion,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Claude event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function suggestions(events: AgentStreamEvent[]) {
  return events.filter(
    (event): event is Extract<AgentStreamEvent, { type: "prompt_suggestion" }> =>
      event.type === "prompt_suggestion",
  );
}

afterEach(() => {
  queryFactory.mockReset();
});

test("enables SDK suggestions and attaches the post-result message to its completed turn", async () => {
  const sessionId = "claude-prompt-suggestion-session";
  const query = createScriptedQuery(sessionId);
  let options: Record<string, unknown> | undefined;
  queryFactory.mockImplementation(
    (input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      options = input.options;
      return query;
    },
  );
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    const started = await session.startTurn("First prompt");
    expect(options?.promptSuggestions).toBe(true);

    query.emit(successResult(sessionId, "11111111-1111-4111-8111-111111111111"));
    await waitFor(() => events.some((event) => event.type === "turn_completed"));
    query.emit(
      promptSuggestion(
        sessionId,
        "22222222-2222-4222-8222-222222222222",
        "Run the focused tests, then ship it.",
      ),
    );
    await waitFor(() => suggestions(events).length === 1);

    const suggestion = suggestions(events)[0];
    expect(suggestion).toEqual({
      type: "prompt_suggestion",
      provider: "claude",
      turnId: started.turnId,
      suggestion: "Run the focused tests, then ship it.",
      messageId: "22222222-2222-4222-8222-222222222222",
    });
    expect(events.findIndex((event) => event.type === "turn_completed")).toBeLessThan(
      events.findIndex((event) => event.type === "prompt_suggestion"),
    );
  } finally {
    unsubscribe();
    await session.close();
  }
});

test("lets an explicit provider option disable SDK suggestions", async () => {
  const query = createScriptedQuery("claude-option-override-session");
  let options: Record<string, unknown> | undefined;
  queryFactory.mockImplementation((input: { options: Record<string, unknown> }) => {
    options = input.options;
    return query;
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    providerOptions: { promptSuggestions: false },
  });

  try {
    await session.startTurn("No suggestion please");
    expect(options?.promptSuggestions).toBe(false);
  } finally {
    await session.close();
  }
});

test("drops a completed turn suggestion after a newer turn starts", async () => {
  const sessionId = "claude-stale-suggestion-session";
  const query = createScriptedQuery(sessionId);
  queryFactory.mockReturnValue(query);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    await session.startTurn("First prompt");
    query.emit(successResult(sessionId, "33333333-3333-4333-8333-333333333333"));
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 1);

    const second = await session.startTurn("Second prompt");
    query.emit(
      promptSuggestion(
        sessionId,
        "44444444-4444-4444-8444-444444444444",
        "This stale suggestion must disappear.",
      ),
    );
    query.emit({
      type: "assistant",
      session_id: sessionId,
      uuid: "55555555-5555-4555-8555-555555555555",
      message: { content: "Second turn marker" },
    });
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("Second turn marker"),
      ),
    );
    expect(suggestions(events)).toEqual([]);

    query.emit(successResult(sessionId, "66666666-6666-4666-8666-666666666666"));
    await waitFor(() => events.filter((event) => event.type === "turn_completed").length === 2);
    query.emit(
      promptSuggestion(
        sessionId,
        "77777777-7777-4777-8777-777777777777",
        "Use the current turn suggestion.",
      ),
    );
    await waitFor(() => suggestions(events).length === 1);
    expect(suggestions(events)[0]?.turnId).toBe(second.turnId);
  } finally {
    unsubscribe();
    await session.close();
  }
});

test.each([
  {
    name: "mismatched session",
    sessionId: "another-session",
    suggestion: "Wrong conversation",
  },
  { name: "blank text", sessionId: "claude-invalid-suggestion-session", suggestion: "   \n" },
  {
    name: "overlong text",
    sessionId: "claude-invalid-suggestion-session",
    suggestion: "x".repeat(501),
  },
])("drops $name suggestions", async ({ sessionId: messageSessionId, suggestion }) => {
  const sessionId = "claude-invalid-suggestion-session";
  const query = createScriptedQuery(sessionId);
  queryFactory.mockReturnValue(query);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));

  try {
    await session.startTurn("Prompt");
    query.emit(successResult(sessionId, "88888888-8888-4888-8888-888888888888"));
    await waitFor(() => events.some((event) => event.type === "turn_completed"));
    query.emit(
      promptSuggestion(messageSessionId, "99999999-9999-4999-8999-999999999999", suggestion),
    );
    query.emit({
      type: "system",
      subtype: "status",
      session_id: sessionId,
      status: "compacting",
    });
    await waitFor(() => query.next.mock.calls.length >= 4);
    expect(suggestions(events)).toEqual([]);
  } finally {
    unsubscribe();
    await session.close();
  }
});
