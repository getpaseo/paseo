import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentSession } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
  waitForNextEvent,
  waitForTimelineToolCall,
} from "./codex/test-utils/fake-app-server.js";

const THREAD = "thread-1";
const TERMINATE = "thread/backgroundTerminals/terminate";

type Handler = (params: unknown) => unknown;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function paramsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

let sessions: AgentSession[] = [];

afterEach(async () => {
  for (const session of sessions) await session.close().catch(() => undefined);
  sessions = [];
});

/**
 * A Codex app-server whose interrupt ends the turn the way Codex does: an `interrupted`
 * turn completion, then the response. `terminate` answers per process.
 */
function createHarness(
  options: {
    terminate?: (processId: string) => unknown;
    interruptResponse?: (completeTurn: () => void) => unknown;
  } = {},
) {
  const handlers: Record<string, Handler> = {
    "thread/backgroundTerminals/list": () => ({ data: [], nextCursor: null }),
    "turn/interrupt": () => {
      const completeTurn = () =>
        appServer.completeTurn({ threadId: THREAD, status: "interrupted" });
      if (options.interruptResponse) return options.interruptResponse(completeTurn);
      completeTurn();
      return {};
    },
    [TERMINATE]: (params) =>
      options.terminate?.(String(paramsOf(params).processId)) ?? { terminated: true },
  };
  const appServer: FakeCodexAppServer = createFakeCodexAppServer(handlers);
  const session = new CodexAppServerAgentSession(
    {
      provider: "codex",
      cwd: "/workspace/project",
      modeId: "auto",
      model: "gpt-5.4",
    },
    null,
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);

  function requests(method: string): Record<string, unknown>[] {
    return appServer
      .requests()
      .filter((message) => message.method === method && "id" in message)
      .map((message) => paramsOf(message.params));
  }

  function terminated(): string[] {
    return requests(TERMINATE)
      .map((params) => String(params.processId))
      .sort();
  }

  // Starts a turn and lets Codex identify it as `nativeTurnId`.
  async function startTurn(prompt: string, nativeTurnId: string): Promise<void> {
    const before = requests("turn/start").length;
    const started = session.startTurn(prompt);
    await vi.waitFor(() => expect(requests("turn/start")).toHaveLength(before + 1), {
      timeout: 5_000,
    });
    const turnStarted = waitForNextEvent(session, "turn_started");
    appServer.startsTurn({ threadId: THREAD, turnId: nativeTurnId });
    await started;
    await turnStarted;
  }

  async function runsCommand(params: { turnId: string; processId: string }): Promise<void> {
    const itemId = `exec-${params.processId}`;
    const shown = waitForTimelineToolCall(session, itemId);
    appServer.startsTerminalCommand({
      threadId: THREAD,
      turnId: params.turnId,
      itemId,
      processId: params.processId,
      command: `sleep ${params.processId}`,
    });
    await shown;
  }

  async function completesTurn(): Promise<void> {
    const completed = waitForNextEvent(session, "turn_completed");
    appServer.completeTurn({ threadId: THREAD });
    await completed;
  }

  // Interrupts the running turn and waits for the session to report it canceled, as a
  // caller does before it starts the next turn: Codex notifications are handled in order
  // but asynchronously, so the interrupt's answer can arrive before the turn has ended.
  async function interrupts(): Promise<void> {
    const canceled = waitForNextEvent(session, "turn_canceled");
    await session.interrupt();
    await canceled;
  }

  return {
    appServer,
    session,
    requests,
    terminated,
    startTurn,
    runsCommand,
    completesTurn,
    interrupts,
  };
}

// Turn A leaves a server running on purpose and completes. Turn B starts two
// commands, and a subagent on its own thread starts a third, then B is interrupted.
async function interruptTurnB(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.startTurn("start a server", "native-A");
  await harness.runsCommand({ turnId: "native-A", processId: "101" });
  await harness.completesTurn();

  await harness.startTurn("run two commands", "native-B");
  await harness.runsCommand({ turnId: "native-B", processId: "201" });
  // A subagent thread's command shows no row here; the next command's row shows it
  // was read, because notifications are read in order.
  harness.appServer.startsTerminalCommand({
    threadId: "child-thread",
    turnId: "native-B",
    itemId: "exec-209",
    processId: "209",
    command: "sleep 209",
  });
  await harness.runsCommand({ turnId: "native-B", processId: "202" });
  await harness.interrupts();
}

describe("an interrupted Codex turn's commands end before the next turn", () => {
  test("terminates exactly the processes the interrupted turn started, by id, and never cleans", async () => {
    const harness = createHarness();
    await interruptTurnB(harness);
    await harness.startTurn("correction", "native-C");

    expect(harness.terminated()).toEqual(["201", "202"]);
    expect(harness.requests(TERMINATE).every((params) => params.threadId === THREAD)).toBe(true);
    // `clean` would end every terminal on the thread, an earlier turn's included.
    expect(
      harness.appServer
        .requests()
        .filter(
          (message) =>
            String(message.method).startsWith("thread/backgroundTerminals/") &&
            message.method !== "thread/backgroundTerminals/list",
        )
        .map((message) => message.method),
    ).toEqual([TERMINATE, TERMINATE]);
    harness.appServer.assertNoErrors();
  });

  test("leaves the next turn's commands running when Codex starts that turn before acknowledging the interrupt", async () => {
    const acknowledge = deferred();
    const harness = createHarness({
      // Codex ends B, starts a turn of its own (a goal continuation), and only then
      // answers the interrupt.
      interruptResponse: (completeTurn) => {
        completeTurn();
        return acknowledge.promise.then(() => ({}));
      },
    });
    await harness.startTurn("run two commands", "native-B");
    await harness.runsCommand({ turnId: "native-B", processId: "201" });
    await harness.runsCommand({ turnId: "native-B", processId: "202" });
    const interrupting = harness.session.interrupt();
    await vi.waitFor(() => expect(harness.requests("turn/interrupt")).toHaveLength(1));
    const autonomousTurn = waitForNextEvent(harness.session, "turn_started");
    harness.appServer.startsTurn({ threadId: THREAD, turnId: "native-C" });
    await autonomousTurn;
    await harness.runsCommand({ turnId: "native-C", processId: "301" });

    acknowledge.resolve();
    await interrupting;
    await vi.waitFor(() => expect(harness.terminated()).toEqual(["201", "202"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.terminated()).toEqual(["201", "202"]);
  });

  test("sends the next turn/start only after the terminates are answered", async () => {
    const answer = deferred();
    const harness = createHarness({
      terminate: () => answer.promise.then(() => ({ terminated: true })),
    });
    await interruptTurnB(harness);
    const next = harness.startTurn("correction", "native-C");
    await vi.waitFor(() => expect(harness.terminated()).toEqual(["201", "202"]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.requests("turn/start")).toHaveLength(2);

    answer.resolve();
    await next;
    expect(harness.requests("turn/start")).toHaveLength(3);
  });

  test.each(["initial", "late"] as const)(
    "tracks both cleanup sweeps when the %s answer arrives first",
    async (answeredFirst) => {
      const first = deferred();
      const second = deferred();
      const harness = createHarness({
        terminate: (processId) =>
          (processId === "201" ? first : second).promise.then(() => ({ terminated: true })),
      });
      await harness.startTurn("run commands", "native-B");
      await harness.runsCommand({ turnId: "native-B", processId: "201" });
      await harness.interrupts();
      await vi.waitFor(() => expect(harness.terminated()).toEqual(["201"]));
      const next = harness.startTurn("correction", "native-C");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.requests("turn/start")).toHaveLength(1);
      // The next turn is already waiting when another process is announced.
      harness.appServer.startsTerminalCommand({
        threadId: THREAD,
        turnId: "native-B",
        itemId: "late-202",
        processId: "202",
        command: "sleep 202",
      });
      harness.appServer.startsTerminalCommand({
        threadId: THREAD,
        turnId: "native-B",
        itemId: "duplicate-202",
        processId: "202",
        command: "sleep 202",
      });
      await vi.waitFor(() => expect(harness.terminated()).toEqual(["201", "202"]));
      (answeredFirst === "initial" ? first : second).resolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.requests("turn/start")).toHaveLength(1);
      (answeredFirst === "initial" ? second : first).resolve();
      await next;
      expect(harness.terminated()).toEqual(["201", "202"]);
      // Accepted state survives the completed sweep and a newer foreground turn.
      harness.appServer.startsTerminalCommand({
        threadId: THREAD,
        turnId: "native-B",
        itemId: "late-203",
        processId: "203",
        command: "sleep 203",
      });
      await vi.waitFor(() => expect(harness.terminated()).toEqual(["201", "202", "203"]));
      harness.appServer.assertNoErrors();
    },
  );

  test("keeps the first sweep pending when a late sweep answers before the next start", async () => {
    const first = deferred();
    const harness = createHarness({
      terminate: (processId) =>
        processId === "201"
          ? first.promise.then(() => ({ terminated: true }))
          : { terminated: true },
    });
    await harness.startTurn("run commands", "native-B");
    await harness.runsCommand({ turnId: "native-B", processId: "201" });
    await harness.interrupts();
    harness.appServer.startsTerminalCommand({
      threadId: THREAD,
      turnId: "native-B",
      itemId: "late-202",
      processId: "202",
      command: "sleep 202",
    });
    await vi.waitFor(() => expect(harness.terminated()).toEqual(["201", "202"]));
    const next = harness.startTurn("correction", "native-C");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.requests("turn/start")).toHaveLength(1);
    first.resolve();
    await next;
    harness.appServer.assertNoErrors();
  });

  test("forgets completed commands but retains failed commands at interrupt", async () => {
    const harness = createHarness();
    await harness.startTurn("run commands", "native-B");
    for (const processId of ["201", "202"]) {
      await harness.runsCommand({ turnId: "native-B", processId });
      harness.appServer.child.stdout.write(
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: THREAD,
            turnId: "native-B",
            item: {
              id: `exec-${processId}`,
              type: "commandExecution",
              processId,
              command: `sleep ${processId}`,
              status: processId === "201" ? "completed" : "failed",
              exitCode: processId === "201" ? 0 : null,
            },
          },
        }) + "\n",
      );
    }
    // A following command's row is a barrier for both completion handlers.
    await harness.runsCommand({ turnId: "native-B", processId: "203" });
    await harness.interrupts();
    await harness.startTurn("correction", "native-C");
    expect(harness.terminated()).toEqual(["202", "203"]);
    harness.appServer.assertNoErrors();
  });

  test("retains accepted interrupts for only the latest sixteen turns", async () => {
    const harness = createHarness();
    for (let index = 0; index < 17; index++) {
      await harness.startTurn("run a command", `native-${index}`);
      await harness.interrupts();
    }
    await harness.startTurn("correction", "native-current");
    harness.appServer.startsTerminalCommand({
      threadId: THREAD,
      turnId: "native-0",
      itemId: "evicted-201",
      processId: "201",
      command: "sleep 201",
    });
    harness.appServer.startsTerminalCommand({
      threadId: THREAD,
      turnId: "native-16",
      itemId: "retained-202",
      processId: "202",
      command: "sleep 202",
    });
    await harness.runsCommand({ turnId: "native-current", processId: "301" });
    expect(harness.terminated()).toEqual(["202"]);
    harness.appServer.assertNoErrors();
  });

  test("a failing or unanswered terminate does not block or fail the next turn", async () => {
    const harness = createHarness({
      // 201 is refused while the next turn waits; 202 is never answered.
      terminate: (processId) =>
        processId === "201"
          ? new Promise((resolve) => setTimeout(resolve, 300)).then(() => ({
              __jsonRpcError: { code: -32600, message: "invalid background terminal process id" },
            }))
          : new Promise(() => {}),
    });
    await interruptTurnB(harness);
    const startedAt = Date.now();
    await harness.startTurn("correction", "native-C");

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(harness.requests("turn/start")).toHaveLength(3);
    expect(harness.terminated()).toEqual(["201", "202"]);
  }, 15_000);
});

test("publishes every page of the current thread's live background terminals", async () => {
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": (params) => {
      const cursor = paramsOf(params).cursor;
      return cursor
        ? { data: [{ itemId: "item-2", processId: "2", command: "sleep 2" }], nextCursor: null }
        : { data: [{ itemId: "item-1", processId: "1", command: "sleep 1" }], nextCursor: "next" };
    },
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", modeId: "auto", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await vi.waitFor(() =>
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [
        { kind: "shell", description: null, command: "sleep 1" },
        { kind: "shell", description: null, command: "sleep 2" },
      ],
    }),
  );
});

test("discards a terminal list overtaken by a command event", async () => {
  const first = deferred<unknown>();
  let lists = 0;
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () =>
      ++lists === 1 ? first.promise : { data: [], nextCursor: null },
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", modeId: "auto", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await vi.waitFor(() => expect(lists).toBe(1));
  const shown = waitForTimelineToolCall(session, "item-new");
  appServer.startsTerminalCommand({
    threadId: THREAD,
    turnId: "turn",
    itemId: "item-new",
    processId: "new",
    command: "sleep 1",
  });
  await shown;
  first.resolve({
    data: [{ itemId: "old", processId: "old", command: "sleep 2" }],
    nextCursor: null,
  });
  await vi.waitFor(() =>
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [],
    }),
  );
  expect(events.filter((event) => event.type === "background_work")).not.toContainEqual(
    expect.objectContaining({ items: [expect.objectContaining({ command: "sleep 2" })] }),
  );
});

test("does not publish a terminal response from a lost runtime", async () => {
  const first = deferred<unknown>();
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () => first.promise,
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", modeId: "auto", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await appServer.waitForRequest("thread/backgroundTerminals/list");
  appServer.disconnect();
  first.resolve({
    data: [{ itemId: "old", processId: "old", command: "sleep 2" }],
    nextCursor: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events.filter((event) => event.type === "background_work")).not.toContainEqual(
    expect.objectContaining({ items: [expect.objectContaining({ command: "sleep 2" })] }),
  );
});

test("accepts a slow terminal snapshot after the polling interval", async () => {
  const pending = deferred<unknown>();
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () => pending.promise,
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await appServer.waitForRequest("thread/backgroundTerminals/list");
  await new Promise((resolve) => setTimeout(resolve, 5200));
  expect(
    appServer.requests().filter((message) => message.method === "thread/backgroundTerminals/list"),
  ).toHaveLength(1);
  pending.resolve({ data: [{ processId: "slow", command: "sleep 120" }], nextCursor: null });
  await vi.waitFor(() =>
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ command: "sleep 120" }],
    }),
  );
  expect(
    appServer.requests().filter((message) => message.method === "thread/backgroundTerminals/list"),
  ).toHaveLength(1);
}, 12000);

test("does not retry an unsupported inventory on later command events", async () => {
  let calls = 0;
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () => {
      calls++;
      return { __jsonRpcError: { code: -32601, message: "Method not found" } };
    },
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  await session.connect();
  await vi.waitFor(() => expect(calls).toBe(1));
  const shown = waitForTimelineToolCall(session, "unsupported-item");
  appServer.startsTerminalCommand({
    threadId: THREAD,
    turnId: "turn",
    itemId: "unsupported-item",
    processId: "1",
    command: "sleep 1",
  });
  await shown;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(calls).toBe(1);
});

test("retries transient inventory failures and cancels retries on stop", async () => {
  vi.useFakeTimers();
  try {
    const { CodexBackgroundInventory } = await import("./codex/background-inventory.js");
    let calls = 0;
    let fail = true;
    const inventory = new CodexBackgroundInventory(() => {});
    inventory.start({
      client: {
        request: async () => {
          calls++;
          if (fail) throw new Error("temporary");
          return { data: [{ processId: "live", command: "sleep 120" }], nextCursor: null };
        },
      },
      thread: THREAD,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(inventory.snapshot()).toBeNull();
    inventory.changed(THREAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(inventory.snapshot()?.items).toMatchObject([{ command: "sleep 120" }]);
    fail = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(inventory.snapshot()?.items).toMatchObject([{ command: "sleep 120" }]);
    inventory.stop();
    const stoppedCalls = calls;
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls).toBe(stoppedCalls);
  } finally {
    vi.useRealTimers();
  }
});

test("does not retry a failure from a stopped inventory generation", async () => {
  vi.useFakeTimers();
  try {
    const { CodexBackgroundInventory } = await import("./codex/background-inventory.js");
    let reject!: (error: Error) => void;
    let calls = 0;
    const response = new Promise<unknown>((_, fail) => {
      reject = fail;
    });
    const inventory = new CodexBackgroundInventory(() => {});
    inventory.start({
      client: {
        request: () => {
          calls++;
          return response;
        },
      },
      thread: THREAD,
    });
    inventory.stop();
    reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(15000);
    expect(calls).toBe(1);
    expect(inventory.snapshot()).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("stops only the selected live background terminal and confirms the roster", async () => {
  const live = new Set(["1", "2"]);
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () => ({
      data: [...live].map((processId) => ({ processId, command: `sleep ${processId}` })),
      nextCursor: null,
    }),
    "thread/backgroundTerminals/terminate": (params) => ({
      terminated: live.delete(String(paramsOf(params).processId)),
    }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await vi.waitFor(() =>
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ command: "sleep 1" }, { command: "sleep 2" }],
    }),
  );
  const item = events
    .findLast((event) => event.type === "background_work")
    ?.items?.find((entry) => entry.command === "sleep 1");
  expect(item).toBeDefined();
  await session.stopBackgroundWork(item!.id);
  expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
    items: [{ command: "sleep 2" }],
  });
  await expect(session.stopBackgroundWork(item!.id)).rejects.toThrow();
});

test("reports a rejected background stop and keeps the item available", async () => {
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () => ({
      data: [{ processId: "1", command: "sleep 1" }],
      nextCursor: null,
    }),
    "thread/backgroundTerminals/terminate": () => ({ terminated: false }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await vi.waitFor(() =>
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ command: "sleep 1" }],
    }),
  );
  const item = events.findLast((event) => event.type === "background_work")?.items?.[0];
  expect(item).toBeDefined();
  await expect(session.stopBackgroundWork(item!.id)).rejects.toThrow("not terminated");
  expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
    items: [{ command: "sleep 1" }],
  });
});

test("does not confirm a stop after the provider connection is lost", async () => {
  const response = deferred<unknown>();
  const appServer = createFakeCodexAppServer({
    "thread/backgroundTerminals/list": () => ({
      data: [{ processId: "1", command: "sleep 1" }],
      nextCursor: null,
    }),
    "thread/backgroundTerminals/terminate": () => response.promise,
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/workspace/project", model: "gpt-5.4" },
    { sessionId: THREAD },
    createTestLogger(),
    async () => appServer.child,
  );
  sessions.push(session);
  const events: import("../agent-sdk-types.js").AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await vi.waitFor(() =>
    expect(events.findLast((event) => event.type === "background_work")).toMatchObject({
      items: [{ command: "sleep 1" }],
    }),
  );
  const item = events.findLast((event) => event.type === "background_work")?.items?.[0];
  expect(item).toBeDefined();
  const pending = session.stopBackgroundWork(item!.id);
  await appServer.waitForRequest("thread/backgroundTerminals/terminate");
  appServer.disconnect();
  response.resolve({ terminated: true });
  await expect(pending).rejects.toThrow();
});
