import type { EventSubscribeOutput } from "@opencode-ai/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./opencode-v2-agent.js";
import { mapOpenCodeV2Commands, parseOpenCodeV2SlashCommandInput } from "./opencode-v2/commands.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./opencode-v2/test-utils/test-opencode-v2-harness.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";

const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

function buildConfig(cwd: string): AgentSessionConfig {
  return {
    provider: "opencode-v2",
    cwd,
    model: TEST_MODEL,
  };
}

function v2Event(
  input: Omit<EventSubscribeOutput, "id" | "created" | "type"> & {
    type: EventSubscribeOutput["type"];
  },
): EventSubscribeOutput {
  return {
    id: "event-1",
    created: 1,
    ...input,
  } as EventSubscribeOutput;
}

function executionSucceededEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.execution.succeeded",
    data: { sessionID: sessionId },
  });
}

function compactionStartedEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.compaction.started",
    data: { sessionID: sessionId, reason: "manual", recent: "", inputID: "msg_compact_1" },
  });
}

function compactionEndedEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.compaction.ended",
    data: { sessionID: sessionId, reason: "manual" },
  });
}

interface TurnResult {
  events: AgentStreamEvent[];
  turnCompleted: boolean;
  turnFailed: boolean;
  error?: string;
}

function isTurnFailedEvent(streamEvent: AgentStreamEvent): boolean {
  return streamEvent.type === "turn_failed";
}

async function collectTurnEvents(iterator: AsyncGenerator<AgentStreamEvent>): Promise<TurnResult> {
  const result: TurnResult = {
    events: [],
    turnCompleted: false,
    turnFailed: false,
  };

  for await (const streamEvent of iterator) {
    result.events.push(streamEvent);
    if (streamEvent.type === "turn_completed") {
      result.turnCompleted = true;
      break;
    }
    if (streamEvent.type === "turn_failed") {
      result.turnFailed = true;
      result.error = streamEvent.error;
      break;
    }
    if (streamEvent.type === "turn_canceled") {
      break;
    }
  }

  return result;
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await assertion();
}

async function createSession(
  sessionId = "session-1",
  configure?: (openCode: TestOpenCodeV2Client) => void,
): Promise<{
  readonly session: Awaited<ReturnType<OpenCodeV2AgentClient["createSession"]>>;
  readonly openCode: TestOpenCodeV2Client;
  readonly runtime: TestOpenCodeV2Harness;
}> {
  const runtime = new TestOpenCodeV2Harness();
  const openCode = new TestOpenCodeV2Client();
  openCode.sessionCreateResponse = {
    ...openCode.sessionCreateResponse,
    id: sessionId,
  };
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession(buildConfig("/workspace/repo"));
  return { session, openCode, runtime };
}

function setCustomCommands(
  openCode: TestOpenCodeV2Client,
  commands: Array<{ name: string; description?: string }>,
): void {
  openCode.commandListResponse = {
    ...openCode.commandListResponse,
    data: commands,
  };
}

describe("opencode-v2 command listing", () => {
  test("mapOpenCodeV2Commands includes built-in compact/summarize plus custom commands with descriptions", () => {
    const commands = mapOpenCodeV2Commands([
      { name: "review", description: "Review code for correctness and missing tests" },
      { name: "init", description: "guided AGENTS.md setup" },
    ]);

    expect(commands).toContainEqual({
      name: "compact",
      description: "Compact the current session",
      argumentHint: "",
      kind: "command",
    });
    expect(commands).toContainEqual({
      name: "summarize",
      description: "Compact the current session",
      argumentHint: "",
      kind: "command",
    });
    expect(commands).toContainEqual({
      name: "review",
      description: "Review code for correctness and missing tests",
      argumentHint: "",
      kind: "command",
    });
    expect(commands).toContainEqual({
      name: "init",
      description: "guided AGENTS.md setup",
      argumentHint: "",
      kind: "command",
    });
  });

  test("mapOpenCodeV2Commands falls back to an empty description when the server omits it", () => {
    const commands = mapOpenCodeV2Commands([{ name: "bare" }]);
    expect(commands).toContainEqual({
      name: "bare",
      description: "",
      argumentHint: "",
      kind: "command",
    });
  });

  test("listCommands returns live commands with names and descriptions", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [
      { name: "review", description: "Review code for correctness and missing tests" },
    ]);

    const commands = await session.listCommands();

    expect(commands).toContainEqual({
      name: "review",
      description: "Review code for correctness and missing tests",
      argumentHint: "",
      kind: "command",
    });
    expect(openCode.calls.commandList).toHaveLength(1);
    expect(openCode.calls.commandList[0]).toEqual({
      location: { directory: "/workspace/repo" },
    });

    await session.close();
  });

  test("listCommands reflects live runtime commands, not a stale cache", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);

    const first = await session.listCommands();
    expect(first.some((command) => command.name === "review")).toBe(true);
    expect(first.some((command) => command.name === "shipit")).toBe(false);

    // A second command is registered on the live server; the next listing must
    // pick it up without any provider restart.
    setCustomCommands(openCode, [
      { name: "review", description: "Review changes" },
      { name: "shipit", description: "Ship the current changes" },
    ]);
    const second = await session.listCommands();

    expect(second.some((command) => command.name === "shipit")).toBe(true);
    expect(second).toContainEqual({
      name: "shipit",
      description: "Ship the current changes",
      argumentHint: "",
      kind: "command",
    });
    expect(openCode.calls.commandList).toHaveLength(2);

    await session.close();
  });

  test("listCommands retries briefly when the server's command registry is still loading", async () => {
    const { session, openCode } = await createSession();
    // First command.list returns an empty payload (cold-start load race), then
    // the registry is populated.
    let calls = 0;
    openCode.commandListImplementation = async () => {
      calls += 1;
      return {
        ...openCode.commandListResponse,
        data: calls === 1 ? [] : [{ name: "review", description: "Review changes" }],
      };
    };

    const commands = await session.listCommands();

    expect(calls).toBeGreaterThan(1);
    expect(commands.some((command) => command.name === "review")).toBe(true);

    await session.close();
  });

  test("client-level listCommands acquires the server and lists commands", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

    const commands = await client.listCommands(buildConfig("/workspace/repo"));

    expect(commands.some((command) => command.name === "review")).toBe(true);
    expect(runtime.acquisitions).toHaveLength(1);
    expect(runtime.acquisitions[0].releaseCount).toBe(1);
  });
});

describe("opencode-v2 slash command dispatch", () => {
  test("startTurn dispatches a known custom command via session.command with the argument text", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);

    const iterator = streamSession(session, "/review the auth module");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionCommand).toHaveLength(1);
    });
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(turn.turnFailed).toBe(false);
    expect(openCode.calls.sessionCommand).toEqual([
      {
        sessionID: "session-1",
        command: "review",
        text: "the auth module",
      },
    ]);
    expect(openCode.calls.sessionPrompt).toHaveLength(0);

    await session.close();
  });

  test("startTurn dispatches a known custom command without arguments", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);

    const iterator = streamSession(session, "/review");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionCommand).toHaveLength(1);
    });
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(openCode.calls.sessionCommand).toEqual([
      {
        sessionID: "session-1",
        command: "review",
        text: "",
      },
    ]);

    await session.close();
  });

  test("startTurn dispatches /compact via session.compact and completes the turn", async () => {
    const { session, openCode } = await createSession();

    const iterator = streamSession(session, "/compact");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionCompact).toHaveLength(1);
    });
    openCode.emitEvent(compactionStartedEvent("session-1"));
    openCode.emitEvent(compactionEndedEvent("session-1"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(openCode.calls.sessionCompact).toEqual([{ sessionID: "session-1" }]);
    expect(openCode.calls.sessionPrompt).toHaveLength(0);
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      }),
    );

    await session.close();
  });

  test("startTurn dispatches /summarize via session.compact", async () => {
    const { session, openCode } = await createSession();

    const iterator = streamSession(session, "/summarize");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionCompact).toHaveLength(1);
    });
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(openCode.calls.sessionCompact).toEqual([{ sessionID: "session-1" }]);

    await session.close();
  });

  test("startTurn surfaces a clear notice for an unknown command and falls back to plain prompt", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);

    const iterator = streamSession(session, "/definitely-not-a-real-command-xyz");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionPrompt).toHaveLength(1);
    });
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(turn.turnFailed).toBe(false);
    // The unknown command is surfaced as a clear notice...
    expect(turn.events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "error",
          message: "Unknown command '/definitely-not-a-real-command-xyz'; sending as plain text",
        },
      }),
    );
    // ...and the raw text is still sent to the model as a plain prompt.
    expect(openCode.calls.sessionCommand).toHaveLength(0);
    expect(openCode.calls.sessionPrompt).toEqual([
      {
        sessionID: "session-1",
        text: "/definitely-not-a-real-command-xyz",
        resume: true,
      },
    ]);

    await session.close();
  });

  test("a path-like prompt such as /etc/hosts is sent as plain text, not treated as a command", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);

    const iterator = streamSession(session, "/etc/hosts");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionPrompt).toHaveLength(1);
    });
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(openCode.calls.sessionCommand).toHaveLength(0);
    expect(openCode.calls.sessionPrompt).toEqual([
      {
        sessionID: "session-1",
        text: "/etc/hosts",
        resume: true,
      },
    ]);

    await session.close();
  });

  test("a plain prompt still dispatches session.prompt", async () => {
    const { session, openCode } = await createSession();

    const iterator = streamSession(session, "Say hello");
    const turnPromise = collectTurnEvents(iterator);

    await waitFor(() => {
      expect(openCode.calls.sessionPrompt).toHaveLength(1);
    });
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(openCode.calls.sessionPrompt).toEqual([
      {
        sessionID: "session-1",
        text: "Say hello",
        resume: true,
      },
    ]);
    expect(openCode.calls.sessionCommand).toHaveLength(0);

    await session.close();
  });

  test("a failed command dispatch surfaces a clear turn failure and leaves the session usable", async () => {
    const { session, openCode } = await createSession();
    setCustomCommands(openCode, [{ name: "review", description: "Review changes" }]);
    openCode.sessionCommandError = new Error("Command execution failed: boom");

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.startTurn("/review the auth module");
    await waitFor(() => {
      const failed = events.some(isTurnFailedEvent);
      expect(failed).toBe(true);
    });
    expect(events.find((streamEvent) => streamEvent.type === "turn_failed")).toMatchObject({
      type: "turn_failed",
      error: "Command execution failed: boom",
    });

    // The failed command turn must not corrupt the session: a normal prompt works.
    const secondRun = session.run("Now say hi");
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await secondRun;
    expect(result.sessionId).toBe("session-1");
    expect(openCode.calls.sessionPrompt).toHaveLength(1);

    await session.close();
  });
});

describe("parseOpenCodeV2SlashCommandInput", () => {
  test("parses a command with arguments", () => {
    expect(parseOpenCodeV2SlashCommandInput("/review the auth module")).toEqual({
      commandName: "review",
      args: "the auth module",
    });
  });

  test("parses a command without arguments", () => {
    expect(parseOpenCodeV2SlashCommandInput("/review")).toEqual({ commandName: "review" });
  });

  test("returns null for non-slash input", () => {
    expect(parseOpenCodeV2SlashCommandInput("review the auth module")).toBeNull();
    expect(parseOpenCodeV2SlashCommandInput("")).toBeNull();
  });

  test("returns null for a bare slash and for names containing another slash", () => {
    expect(parseOpenCodeV2SlashCommandInput("/")).toBeNull();
    expect(parseOpenCodeV2SlashCommandInput("/etc/hosts")).toBeNull();
  });
});
