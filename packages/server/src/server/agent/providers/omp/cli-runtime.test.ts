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

function createOmpChild(options?: {
  supportedProtocolVersions?: number[];
  emitReady?: boolean;
  maxFrameBytes?: number;
}): OmpChild {
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
  // Real OMP writes a `ready` frame immediately after launch; the runtime waits
  // for it before negotiating the RPC protocol. Advertise v1-only by default so
  // the session stays on protocol v1 and command streams are unaffected.
  if (options?.emitReady !== false) {
    child.stdout.write(
      `${JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: options?.supportedProtocolVersions ?? [1],
        maxFrameBytes: options?.maxFrameBytes ?? 1024 * 1024,
        maxReassembledFrameBytes: 64 * 1024 * 1024,
      })}\n`,
    );
  }
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

  test("accepts model catalogs with null contextWindow from NVIDIA", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => ({
      models: [
        {
          provider: "nvidia",
          id: "minimaxai/minimax-m3",
          name: "MiniMax-M3",
          contextWindow: null,
        },
        {
          provider: "zai",
          id: "glm-5.2",
          name: "GLM-5.2",
          contextWindow: 131_072,
        },
      ],
    }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "nvidia",
        id: "minimaxai/minimax-m3",
        contextWindow: null,
      }),
      expect.objectContaining({
        provider: "zai",
        id: "glm-5.2",
        contextWindow: 131_072,
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

  test("negotiates RPC protocol v2 when OMP advertises it", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      if (command.type === "negotiate_protocol") {
        return { protocolVersion: command.protocolVersion };
      }
      if (command.type === "get_available_models") {
        return {
          models: [{ provider: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        };
      }
      return undefined;
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({ provider: "opencode-go", id: "deepseek-v4-flash" }),
    ]);
    expect(commands.map(withoutRequestId)).toContainEqual({
      type: "negotiate_protocol",
      protocolVersion: 2,
    });
  });

  test("stays on protocol v1 when OMP advertises incompatible framing limits", async () => {
    const child = createOmpChild({
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 512 * 1024,
    });
    const commands: Record<string, unknown>[] = [];
    replyToCommands(child, (command) => {
      commands.push(command);
      return { models: [] };
    });

    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    await session.getAvailableModels();

    expect(commands.map(withoutRequestId)).toEqual([{ type: "get_available_models" }]);
    await session.close();
  });

  test("rejects startup when OMP exits before advertising readiness", async () => {
    const child = createOmpChild({ emitReady: false });
    const startup = createRuntime(child).startSession({ cwd: "/workspace/project" });

    child.stderr.write("startup exploded");
    child.emit("exit", 7, null);

    await expect(startup).rejects.toThrow("startup exploded");
  });

  test("rejects startup when OMP exits during protocol negotiation", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    child.stdin.on("data", () => {
      child.stderr.write("negotiation exploded");
      child.emit("exit", 8, null);
    });

    await expect(createRuntime(child).startSession({ cwd: "/workspace/project" })).rejects.toThrow(
      "negotiation exploded",
    );
  });

  test("reassembles chunked protocol v2 responses for large payloads", async () => {
    const child = createOmpChild({ supportedProtocolVersions: [1, 2] });
    const models = Array.from({ length: 2_000 }, (_, index) => ({
      provider: "p",
      id: `model-${index}`,
      name: `model-${index}-${"x".repeat(512)}`,
    }));
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.type === "negotiate_protocol") {
          child.stdout.write(
            `${JSON.stringify({
              id: command.id,
              type: "response",
              command: command.type,
              success: true,
              data: { protocolVersion: 2 },
            })}\n`,
          );
          continue;
        }
        if (command.type === "get_available_models") {
          // Emit a logical response larger than the 1 MiB protocol-v1 cap as a
          // chunked (protocol v2) frame sequence, like real OMP does.
          const logical = JSON.stringify({
            id: command.id,
            type: "response",
            command: command.type,
            success: true,
            data: { models },
          });
          const bytes = Buffer.from(logical, "utf8");
          expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
          const chunkPayload = 256 * 1024;
          const count = Math.ceil(bytes.length / chunkPayload);
          for (let index = 0; index < count; index++) {
            child.stdout.write(
              `${JSON.stringify({
                type: "rpc_chunk",
                chunkId: "c1",
                index,
                count,
                byteLength: bytes.length,
                data: bytes
                  .subarray(index * chunkPayload, (index + 1) * chunkPayload)
                  .toString("base64"),
              })}\n`,
            );
          }
        }
      }
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const result = await session.getAvailableModels();
    expect(result).toHaveLength(2_000);
    expect(result[0]).toEqual(expect.objectContaining({ id: "model-0" }));
  });
});
