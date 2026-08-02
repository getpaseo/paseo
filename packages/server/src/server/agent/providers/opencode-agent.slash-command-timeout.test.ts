import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  idleEvent,
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OpenCodeAgentSession slash command timeout handling", () => {
  test("lists only OpenCode built-in slash commands Paseo can execute", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    await expect(session.listCommands?.()).resolves.toEqual(
      expect.arrayContaining([
        {
          name: "compact",
          description: "Compact the current session",
          argumentHint: "",
          kind: "command",
        },
      ]),
    );
    await expect(session.listCommands?.()).resolves.not.toEqual(
      expect.arrayContaining([
        { name: "models", description: expect.any(String), argumentHint: "" },
      ]),
    );
  });

  test("executes compact through the OpenCode summarize endpoint", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    await expect(session.run("/compact")).resolves.toMatchObject({
      sessionId: "session-1",
      finalText: "",
      timeline: [],
      usage: undefined,
    });
    expect(openCodeClient.calls.sessionSummarize).toEqual([
      { sessionID: "session-1", directory: "/tmp" },
    ]);
    expect(openCodeClient.calls.sessionCommand).toEqual([]);
  });

  test("rejects pre-dispatch idle and waits for timeout-owned SSE completion", async () => {
    const staleIdleGate = createDeferred<void>();
    const staleIdleConsumed = createDeferred<void>();
    const acceptedIdleGate = createDeferred<void>();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    openCodeClient.sessionCommandError = new Error("fetch failed: Headers Timeout Error");
    openCodeClient.commandListResponse = {
      data: [{ name: "help", description: "Show help", hints: [] }],
    };
    openCodeClient.sessionMessagesImplementation = async () => {
      staleIdleGate.resolve();
      await staleIdleConsumed.promise;
      return { data: [] };
    };
    openCodeClient.eventStream = (async function* () {
      await staleIdleGate.promise;
      yield idleEvent();
      staleIdleConsumed.resolve();
      await acceptedIdleGate.promise;
      yield idleEvent();
    })();
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });
    const terminalEvents: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      ) {
        terminalEvents.push(event.type);
      }
    });

    try {
      const runPromise = session.run("/help");
      await vi.waitFor(() => {
        expect(openCodeClient.calls.sessionCommand).toHaveLength(1);
      });
      expect(terminalEvents).toEqual([]);
      acceptedIdleGate.resolve();

      await expect(runPromise).resolves.toMatchObject({
        sessionId: "session-1",
        finalText: "",
        timeline: [],
        usage: undefined,
      });
      expect(terminalEvents).toEqual(["turn_completed"]);
    } finally {
      staleIdleGate.resolve();
      staleIdleConsumed.resolve();
      acceptedIdleGate.resolve();
      unsubscribe();
      await session.close();
    }
  });

  test("leaves successful slash command turns open until OpenCode emits idle", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    openCodeClient.sessionCommandEvents = [];
    openCodeClient.commandListResponse = {
      data: [{ name: "help", description: "Show help", hints: [] }],
    };
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    const runPromise = session.run("/help");
    await nextTick();
    await nextTick();

    expect(openCodeClient.calls.sessionCommand).toHaveLength(1);
    let settled = false;
    void runPromise.then(() => {
      settled = true;
      return undefined;
    });
    await nextTick();
    expect(settled).toBe(false);

    openCodeClient.emitEvent(idleEvent());

    await expect(runPromise).resolves.toMatchObject({
      sessionId: "session-1",
      finalText: "",
      timeline: [],
      usage: undefined,
    });
  });
});

function createOpenCodeClientWithConnectedProvider(): TestOpenCodeClient {
  const openCodeClient = new TestOpenCodeClient();
  openCodeClient.providerListResponse = {
    data: {
      connected: ["openai"],
      all: [{ id: "openai", name: "OpenAI", models: {} }],
    },
  };
  return openCodeClient;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
