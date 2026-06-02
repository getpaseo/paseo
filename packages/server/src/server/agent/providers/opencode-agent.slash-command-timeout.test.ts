import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import {
  idleEvent,
  TestOpenCodeClient,
  TestOpenCodeRuntime,
} from "./opencode/test-utils/test-opencode-runtime.js";

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
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
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
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
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

  test("waits for SSE completion when slash commands hit a header timeout", async () => {
    const idleEventGate = createDeferred<void>();
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    openCodeClient.sessionCommandError = new Error("fetch failed: Headers Timeout Error");
    openCodeClient.commandListResponse = {
      data: [{ name: "help", description: "Show help", hints: [] }],
    };
    openCodeClient.eventStream = (async function* () {
      await idleEventGate.promise;
      yield {
        type: "session.idle",
        properties: { sessionID: "session-1" },
      };
    })();
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp" });

    const runPromise = session.run("/help");
    await Promise.resolve();
    idleEventGate.resolve();

    await expect(runPromise).resolves.toMatchObject({
      sessionId: "session-1",
      finalText: "",
      timeline: [],
      usage: undefined,
    });
  });

  test("leaves successful slash command turns open until OpenCode emits idle", async () => {
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = createOpenCodeClientWithConnectedProvider();
    openCodeClient.sessionCommandEvents = [];
    openCodeClient.commandListResponse = {
      data: [{ name: "help", description: "Show help", hints: [] }],
    };
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
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
