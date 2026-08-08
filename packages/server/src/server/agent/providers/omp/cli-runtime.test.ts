import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { OmpCliRuntime } from "./cli-runtime.js";
import type { OmpRuntimeLaunch, OmpRuntimeSession } from "./runtime.js";

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
  respond: (command: Record<string, unknown>, result: unknown) => void = (command, result) => {
    child.stdout.write(
      `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: result,
      })}\n`,
    );
  },
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
      respond(command, handler(command));
    }
  });
}

/** Serialize `response` as an ordered OMP v2 `rpc_chunk` sequence totaling > 1 MiB. */
function serializeChunkedResponse(response: Record<string, unknown>, chunkId = "rpc-1"): string {
  const bytes = Buffer.from(JSON.stringify(response), "utf8");
  const data = bytes.toString("base64");
  const chunkChars = 4 * 64 * 1024; // decodes to 192 KiB per chunk, under the 256 KiB cap
  const count = Math.ceil(data.length / chunkChars);
  let serialized = "";
  for (let index = 0; index < count; index += 1) {
    serialized += `${JSON.stringify({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: data.slice(index * chunkChars, (index + 1) * chunkChars),
    })}\n`;
  }
  return serialized;
}

function writeChunkedResponse(child: OmpChild, response: Record<string, unknown>): void {
  child.stdout.write(serializeChunkedResponse(response));
}

function withoutRequestId(command: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = command;
  return rest;
}

const OMP_V1_READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

const OMP_V2_READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

function emitReady(child: OmpChild, ready: Record<string, unknown> = OMP_V1_READY): void {
  child.stdout.write(`${JSON.stringify(ready)}\n`);
}

function startSessionWithReady(
  child: OmpChild,
  ready: Record<string, unknown> = OMP_V1_READY,
  launches: OmpRuntimeLaunch[] = [],
): Promise<OmpRuntimeSession> {
  emitReady(child, ready);
  return createRuntime(child, launches).startSession({ cwd: "/workspace/project" });
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
    const session = await startSessionWithReady(child);

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
    const session = await startSessionWithReady(child);

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
    const session = await startSessionWithReady(child);

    await expect(session.getState()).rejects.toThrow();
  });

  test("emits validated known events and drops unknown frames", async () => {
    const child = createOmpChild();
    const session = await startSessionWithReady(child);
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
    const session = await startSessionWithReady(child);

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
    const session = await startSessionWithReady(child);

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
    const session = await startSessionWithReady(child);

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
    const session = await startSessionWithReady(child);

    await session.setSubagentSubscription("events");

    expect(commands.map(withoutRequestId)).toEqual([
      { type: "set_subagent_subscription", level: "events" },
    ]);
  });

  test("accepts the empty prompt acknowledgement emitted by OMP 17", async () => {
    const child = createOmpChild();
    replyToCommands(child, () => undefined);
    const session = await startSessionWithReady(child);

    await expect(session.prompt("hello")).resolves.toEqual({ requestId: "req_1" });
  });

  test("keeps v1-only peers usable without sending negotiation", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        model: null,
        isStreaming: false,
        isCompacting: false,
        sessionId: "session-1",
        messageCount: 0,
        queuedMessageCount: 0,
      };
    });
    const session = await startSessionWithReady(child, OMP_V1_READY);

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
    expect(commandTypes).toEqual(["get_state"]);
  });

  test("negotiates protocol v2 once before returning a usable session", async () => {
    const child = createOmpChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      if (command.type === "negotiate_protocol") {
        return { protocolVersion: 2 };
      }
      return {
        model: null,
        isStreaming: false,
        isCompacting: false,
        sessionId: "session-1",
        messageCount: 0,
        queuedMessageCount: 0,
      };
    });
    const session = await startSessionWithReady(child, OMP_V2_READY);

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
    expect(commandTypes).toEqual(["negotiate_protocol", "get_state"]);
  });

  test("rejects startup when the negotiation confirmation is invalid", async () => {
    const child = createOmpChild();
    replyToCommands(
      child,
      () => undefined,
      (command, _result) => {
        child.stdout.write(
          `${JSON.stringify({
            id: command.id,
            type: "response",
            command: "negotiate_protocol",
            success: true,
            data: { protocolVersion: 1 },
          })}\n`,
        );
      },
    );

    await expect(startSessionWithReady(child, OMP_V2_READY)).rejects.toThrow(
      "OMP RPC protocol v2 negotiation failed",
    );
  });

  test("keeps the transport usable when negotiation and a chunked frame share stdout data", async () => {
    const child = createOmpChild();
    replyToCommands(
      child,
      (command) => {
        if (command.type === "negotiate_protocol") {
          return { protocolVersion: 2 };
        }
        return {
          model: null,
          isStreaming: false,
          isCompacting: false,
          sessionId: "session-1",
          messageCount: 0,
          queuedMessageCount: 0,
        };
      },
      (command, result) => {
        if (command.type !== "negotiate_protocol") {
          child.stdout.write(
            `${JSON.stringify({
              id: command.id,
              type: "response",
              command: command.type,
              success: true,
              data: result,
            })}\n`,
          );
          return;
        }

        const frame = {
          type: "notice",
          message: "x".repeat(1_100_000),
        };
        child.stdout.write(
          `${JSON.stringify({
            id: command.id,
            type: "response",
            command: "negotiate_protocol",
            success: true,
            data: result,
          })}\n${serializeChunkedResponse(frame, "startup-event")}`,
        );
      },
    );
    const session = await startSessionWithReady(child, OMP_V2_READY);

    await expect(session.getState()).resolves.toMatchObject({ sessionId: "session-1" });
  });

  test("resolves a compact response reassembled from chunks larger than 1 MiB", async () => {
    const child = createOmpChild();
    replyToCommands(
      child,
      (command) => {
        if (command.type === "negotiate_protocol") {
          return { protocolVersion: 2 };
        }
        // Oversized payload: forces the response into a multi-chunk v2 sequence.
        return { summary: "x".repeat(1_100_000) };
      },
      (command, result) => {
        if (command.type === "negotiate_protocol") {
          child.stdout.write(
            `${JSON.stringify({
              id: command.id,
              type: "response",
              command: "negotiate_protocol",
              success: true,
              data: { protocolVersion: 2 },
            })}\n`,
          );
          return;
        }
        writeChunkedResponse(child, {
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          data: result,
        });
      },
    );
    const session = await startSessionWithReady(child, OMP_V2_READY);

    await expect(session.compact()).resolves.toBeUndefined();
  });
});
