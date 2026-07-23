import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { OmpCliRuntime } from "./cli-runtime.js";
import type { OmpRuntimeLaunch } from "./runtime.js";

type OmpChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignals: Array<NodeJS.Signals | number | undefined>;
};

function createOmpChild(): OmpChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killedSignals: [],
  }) as OmpChild;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

function createRuntime(child: OmpChild, launches: OmpRuntimeLaunch[] = []): OmpCliRuntime {
  return new OmpCliRuntime({
    logger: pino({ level: "silent" }),
    command: ["omp"],
    commandsRpcName: "get_available_commands",
    spawnProcess: (launch) => {
      launches.push(launch);
      return child;
    },
  });
}

function replyToCommands(
  child: OmpChild,
  handler: (command: Record<string, unknown>) => unknown,
): void {
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const command = JSON.parse(line) as Record<string, unknown>;
      const result = handler(command);
      child.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: result,
        })}\n`,
      );
    }
  });
}

function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = command;
  return rest;
}

describe("OMP CLI runtime", () => {
  test("validates session state with the documented queued message count", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({
      sessionId: "session-1",
      messageCount: 3,
      queuedMessageCount: 1,
    });
  });

  test("accepts session state without thinkingLevel for non-reasoning models", async () => {
    const child = createOmpChild();
    // Models like cursor-grok-4.5-high-fast encode effort in the model ID, so
    // OMP marks them reasoning: false and omits thinkingLevel from get_state.
    replyToCommands(child, () => ({
      model: null,
      isStreaming: false,
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
  });

  test("rejects malformed RPC results instead of trusting transport data", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      thinkingLevel: "medium",
      isStreaming: "no",
      isCompacting: false,
      sessionId: "session-1",
      messageCount: 0,
      queuedMessageCount: 0,
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).rejects.toThrow();
  });

  test("emits validated known events and drops unknown frames", async () => {
    const child = createOmpChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const eventTypes: string[] = [];
    session.onEvent((event) => eventTypes.push(event.type));

    child.stdout.write(`${JSON.stringify({ type: "future_control", enabled: true })}\n`);
    child.stdout.write(`${JSON.stringify({ type: "notice", level: "info", message: "ready" })}\n`);

    expect(eventTypes).toEqual(["notice"]);
  });

  test("lists commands through get_available_commands", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        commands: [
          { name: "prewalk", description: "Prewalk at the next action", source: "builtin" },
        ],
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getCommands()).resolves.toEqual([
      {
        name: "prewalk",
        description: "Prewalk at the next action",
        source: "builtin",
      },
    ]);
    expect(commandTypes).toEqual(["get_available_commands"]);
  });

  test("accepts model catalogs with null maxTokens from newer OMP binaries", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "gpt-5.6-sol",
          maxTokens: null,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        maxTokens: null,
      }),
    ]);
  });

  test("wraps OMP subagent RPC commands", async () => {
    const child = createOmpChild();
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await session.setSubagentSubscription("events");

    expect(commands.map(withoutRequestId)).toEqual([
      { type: "set_subagent_subscription", level: "events" },
    ]);
  });

  test("accepts the empty prompt acknowledgement emitted by OMP 17", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => undefined);
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });
  });
});
