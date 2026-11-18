import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

const SESSION = "interrupted-turn-tasks-session";
const STOP_FAILED = "provider.claude.interrupt.task_stop_failed";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * A Claude query the test scripts frame by frame. `interrupt` and `stopTask` record each call
 * and answer as the test says; by default both answer at once.
 */
function createScriptedQuery(
  prompt: AsyncIterable<unknown>,
  options: {
    interrupt?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
  },
) {
  const frames: Record<string, unknown>[] = [];
  const waiting: Array<(result: IteratorResult<Record<string, unknown>, void>) => void> = [];
  let ended = false;
  let emitted = 0;
  const prompts: string[] = [];
  const promptUuids = new Map<string, string>();

  const query = {
    next: vi.fn(async (): Promise<IteratorResult<Record<string, unknown>, void>> => {
      const frame = frames.shift();
      if (frame) return { value: frame, done: false };
      if (ended) return { value: undefined, done: true };
      return await new Promise((resolve) => waiting.push(resolve));
    }),
    interrupt: vi.fn(options.interrupt ?? (async () => undefined)),
    stopTask: vi.fn(options.stopTask ?? (async (_taskId: string) => undefined)),
    return: vi.fn(async () => {
      ended = true;
      for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
      return { value: undefined, done: true as const };
    }),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    cancelAsyncMessage: vi.fn(async () => false),
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  void (async () => {
    for await (const message of prompt) {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      const blocks = Array.isArray(content) ? content : [{ text: content }];
      const text = blocks.map((block) => String((block as { text?: unknown }).text)).join("");
      promptUuids.set(text, String((message as { uuid?: unknown }).uuid));
      prompts.push(text);
    }
  })();

  return {
    query,
    prompts,
    promptUuids,
    emit(frame: Record<string, unknown>) {
      emitted += 1;
      const resolve = waiting.shift();
      if (resolve) resolve({ value: frame, done: false });
      else frames.push(frame);
    },
    /** The pump asks for its next frame only after routing the last, so this proves routing. */
    async routed() {
      await vi.waitFor(() => expect(query.next.mock.calls.length).toBeGreaterThan(emitted));
    },
  };
}

type ScriptedQuery = ReturnType<typeof createScriptedQuery>;

let sessions: AgentSession[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const session of sessions) await session.close().catch(() => undefined);
  sessions = [];
});

async function createHarness(
  options: {
    interrupt?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
  } = {},
) {
  let scripted: ScriptedQuery | null = null;
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "info" },
    { write: (line: string) => void logs.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const session = await new ClaudeAgentClient({
    logger,
    queryFactory: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      scripted = createScriptedQuery(prompt, options);
      return scripted.query;
    },
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  sessions.push(session);
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));

  const claude = (): ScriptedQuery => {
    if (!scripted) throw new Error("Claude query not created yet");
    return scripted;
  };
  return {
    session,
    events,
    logs,
    claude,
    stoppedTaskIds: () => claude().query.stopTask.mock.calls.map(([taskId]) => taskId),
    /** Sends a prompt and returns the uuid Claude's `command_lifecycle` frames carry for it. */
    async startTurn(text: string): Promise<string> {
      await session.startTurn(text);
      await vi.waitFor(() => expect(claude().prompts).toContain(text));
      return claude().promptUuids.get(text) ?? "";
    },
  };
}

function init() {
  return { type: "system", subtype: "init", session_id: SESSION, permissionMode: "default" };
}

function result(subtype: "success" | "error_during_execution" = "success") {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
    session_id: SESSION,
  };
}

function lifecycle(commandUuid: string, state: "started" | "completed" | "cancelled") {
  return { type: "command_lifecycle", command_uuid: commandUuid, state, session_id: SESSION };
}

function shellTask(taskId: string, isBackgrounded = true) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    task_type: "local_bash",
    description: `run ${taskId}`,
    is_backgrounded: isBackgrounded,
    session_id: SESSION,
  };
}

function taskEnded(taskId: string, status: string) {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status,
    session_id: SESSION,
  };
}

/** A whole turn Claude finishes on its own, leaving its background command running. */
async function runCompletedTurn(
  harness: Awaited<ReturnType<typeof createHarness>>,
  text: string,
  backgroundTaskId: string,
) {
  await harness.startTurn(text);
  const claude = harness.claude();
  claude.emit(init());
  claude.emit(shellTask(backgroundTaskId));
  claude.emit(result());
  await vi.waitFor(() =>
    expect(harness.events.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );
}

test("stops exactly the interrupted turn's running shell tasks, foreground and background, by id", async () => {
  const harness = await createHarness();
  await harness.startTurn("start some commands");
  const claude = harness.claude();
  claude.emit(init());
  claude.emit(shellTask("bg-a"));
  claude.emit(shellTask("fg-a", false));
  claude.emit(shellTask("done-a"));
  claude.emit(taskEnded("done-a", "completed"));
  // A subagent's own command belongs to the subagent, which outlives the turn when backgrounded.
  claude.emit({
    type: "system",
    subtype: "task_started",
    task_id: "agent-task",
    tool_use_id: "toolu_agent",
    task_type: "local_agent",
    subagent_type: "general-purpose",
    description: "Delegate",
    is_backgrounded: true,
    session_id: SESSION,
  });
  claude.emit({
    type: "assistant",
    parent_tool_use_id: "toolu_agent",
    session_id: SESSION,
    message: {
      model: "claude-sonnet-5",
      content: [
        { type: "tool_use", id: "toolu_child-bash", name: "Bash", input: { command: "x" } },
      ],
    },
  });
  claude.emit({ ...shellTask("child-bash"), tool_use_id: "toolu_child-bash" });
  await claude.routed();

  await harness.session.interrupt();

  await vi.waitFor(() => expect(claude.query.interrupt).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(harness.stoppedTaskIds()).toHaveLength(2));
  expect(harness.stoppedTaskIds()).toEqual(["bg-a", "fg-a"]);
  expect(claude.query.interrupt.mock.invocationCallOrder[0]).toBeLessThan(
    claude.query.stopTask.mock.invocationCallOrder[0] ?? 0,
  );
  await vi.waitFor(() =>
    expect(
      harness.logs.filter((log) => log.msg === "provider.claude.interrupt.task_stopped"),
    ).toEqual([
      expect.objectContaining({ taskId: "bg-a" }),
      expect.objectContaining({ taskId: "fg-a" }),
    ]),
  );
});

test("a failing or unanswered stop does not block or fail the interrupt or the next turn", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const harness = await createHarness({
      stopTask: (taskId) =>
        taskId === "bg-refused"
          ? Promise.reject(new Error("stop_task refused"))
          : new Promise<void>(() => undefined),
    });
    await runCompletedTurn(harness, "first", "bg-earlier");
    const claude = harness.claude();
    // Claude starts a turn of its own, so the interrupt below is awaited end to end.
    claude.emit(init());
    claude.emit(shellTask("bg-refused"));
    claude.emit(shellTask("bg-silent"));
    await claude.routed();

    await harness.session.interrupt();

    expect(harness.stoppedTaskIds()).toEqual(["bg-refused", "bg-silent"]);
    // The interrupt returned while one stop was still unanswered.
    expect(harness.logs.filter((log) => log.msg === STOP_FAILED)).not.toContainEqual(
      expect.objectContaining({ taskId: "bg-silent" }),
    );

    await harness.startTurn("next");
    claude.emit(result("error_during_execution"));
    claude.emit(init());
    claude.emit({
      type: "assistant",
      session_id: SESSION,
      message: { id: "msg-next", model: "opus", content: [{ type: "text", text: "next done" }] },
    });
    claude.emit(result());
    await vi.waitFor(() =>
      expect(harness.events.filter((event) => event.type === "turn_completed")).toHaveLength(2),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(harness.logs.filter((log) => log.msg === STOP_FAILED)).toEqual([
        expect.objectContaining({ level: 40, taskId: "bg-refused" }),
        expect.objectContaining({ level: 40, taskId: "bg-silent" }),
      ]),
    );
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// Claude can dequeue a prompt and open its turn after the interrupt was sent. The interrupt was
// for that prompt, so it reaches that turn: its init, and so its task set, arrive afterwards.

test("tells that turn from the next prompt's by the prompt Claude says it started", async () => {
  const interruptAnswered = deferred();
  const harness = await createHarness({ interrupt: () => interruptAnswered.promise });
  const interrupted = await harness.startTurn("start a command");
  const claude = harness.claude();

  await harness.session.interrupt();
  await vi.waitFor(() => expect(claude.query.interrupt).toHaveBeenCalledTimes(1));
  const next = await harness.startTurn("do this instead");
  claude.emit(init());
  claude.emit(lifecycle(interrupted, "started"));
  claude.emit(shellTask("bg-a"));
  claude.emit(result("error_during_execution"));
  claude.emit(lifecycle(next, "started"));
  claude.emit(init());
  claude.emit(shellTask("bg-b"));
  await claude.routed();
  interruptAnswered.resolve();

  await vi.waitFor(() => expect(harness.stoppedTaskIds()).toHaveLength(1));
  expect(harness.stoppedTaskIds()).toEqual(["bg-a"]);
});

test("reaches the turn of a prompt Claude had started but not yet opened a turn for", async () => {
  const interruptAnswered = deferred();
  const harness = await createHarness({ interrupt: () => interruptAnswered.promise });
  const interrupted = await harness.startTurn("start a command");
  const claude = harness.claude();
  claude.emit(lifecycle(interrupted, "started"));
  await claude.routed();

  await harness.session.interrupt();
  await vi.waitFor(() => expect(claude.query.interrupt).toHaveBeenCalledTimes(1));
  await harness.startTurn("do this instead");
  claude.emit(init());
  claude.emit(shellTask("bg-a"));
  await claude.routed();
  interruptAnswered.resolve();

  await vi.waitFor(() => expect(harness.stoppedTaskIds()).toHaveLength(1));
  expect(harness.stoppedTaskIds()).toEqual(["bg-a"]);
});

test("leaves the next turn's commands running when the interrupted prompt opened no turn", async () => {
  const interruptAnswered = deferred();
  const harness = await createHarness({ interrupt: () => interruptAnswered.promise });
  await harness.startTurn("start a command");
  const claude = harness.claude();

  await harness.session.interrupt();
  await vi.waitFor(() => expect(claude.query.interrupt).toHaveBeenCalledTimes(1));
  const next = await harness.startTurn("do this instead");
  // The init is the next prompt's: Claude names the prompt only after it.
  claude.emit(init());
  claude.emit(lifecycle(next, "started"));
  claude.emit(shellTask("bg-b"));
  await claude.routed();
  interruptAnswered.resolve();
  // A task the next turn announces after the interrupt settled.
  claude.emit(shellTask("fg-b", false));
  claude.emit(result());
  await vi.waitFor(() =>
    expect(harness.events.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );

  expect(claude.query.interrupt).toHaveBeenCalledTimes(1);
  expect(harness.stoppedTaskIds()).toEqual([]);
});

test.each([
  { ending: "Claude cancels it", frame: (uuid: string) => lifecycle(uuid, "cancelled") },
  { ending: "its turn fails before it opens", frame: () => result("error_during_execution") },
])(
  "leaves a later turn Claude starts on its own alone when the interrupted prompt ends without a turn: $ending",
  async ({ frame }) => {
    const harness = await createHarness();
    const interrupted = await harness.startTurn("start a command");
    const claude = harness.claude();

    await harness.session.interrupt();
    await vi.waitFor(() => expect(claude.query.interrupt).toHaveBeenCalledTimes(1));
    claude.emit(frame(interrupted));
    await claude.routed();
    // A background job finishing wakes Claude into a turn of its own.
    claude.emit(init());
    claude.emit(shellTask("bg-own"));
    claude.emit(result());
    await vi.waitFor(() =>
      expect(harness.events.filter((event) => event.type === "turn_completed")).toHaveLength(1),
    );

    expect(harness.stoppedTaskIds()).toEqual([]);
  },
);

test("stops a task the interrupted turn announces after its stops were sent, and no later turn's", async () => {
  const harness = await createHarness();
  await harness.startTurn("start a command");
  const claude = harness.claude();
  claude.emit(init());
  claude.emit(shellTask("bg-a"));
  await claude.routed();

  await harness.session.interrupt();
  await vi.waitFor(() => expect(harness.stoppedTaskIds()).toEqual(["bg-a"]));
  claude.emit(shellTask("bg-late"));
  claude.emit(result("error_during_execution"));
  await harness.startTurn("next");
  claude.emit(init());
  claude.emit(shellTask("bg-next"));
  claude.emit(result());
  await vi.waitFor(() =>
    expect(harness.events.filter((event) => event.type === "turn_completed")).toHaveLength(1),
  );

  expect(harness.stoppedTaskIds()).toEqual(["bg-a", "bg-late"]);
});
