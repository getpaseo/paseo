import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { PiCliRuntime } from "./cli-runtime.js";
import type { PiCommandsRpcType } from "./rpc-types.js";
import type { PiRuntimeLaunch } from "./runtime.js";

type PiChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignals: Array<NodeJS.Signals | number | undefined>;
};

function createPiChild(): PiChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killedSignals: [],
  }) as PiChild;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal ?? null));
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

function createRuntime(
  child: PiChild,
  launches: PiRuntimeLaunch[] = [],
  options?: { commandsRpcType?: PiCommandsRpcType },
): PiCliRuntime {
  return new PiCliRuntime({
    logger: pino({ level: "silent" }),
    command: ["pi"],
    commandsRpcType: options?.commandsRpcType,
    spawnProcess: (launch) => {
      launches.push(launch);
      return child;
    },
  });
}

function replyToCommands(
  child: PiChild,
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
      try {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        child.stdout.write(
          `${JSON.stringify({
            id: command.id,
            type: "response",
            command: command.type,
            success: false,
            error: message,
          })}\n`,
        );
      }
    }
  });
}

describe("PiCliRuntime", () => {
  test("starts pi in rpc mode and resolves command responses", async () => {
    const child = createPiChild();
    replyToCommands(child, (command) =>
      command.type === "get_state"
        ? {
            sessionId: "pi-session-1",
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            messageCount: 0,
            pendingMessageCount: 0,
          }
        : {},
    );
    const launches: PiRuntimeLaunch[] = [];
    const runtime = createRuntime(child, launches);

    const session = await runtime.startSession({ cwd: "/workspace/project" });

    await expect(session.getState()).resolves.toMatchObject({
      sessionId: "pi-session-1",
      thinkingLevel: "medium",
    });
    expect(launches).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        argv: ["pi", "--mode", "rpc"],
      }),
    ]);
  });

  test("passes an MCP config path to Pi", async () => {
    const child = createPiChild();
    replyToCommands(child, () => ({}));
    const launches: PiRuntimeLaunch[] = [];
    const runtime = createRuntime(child, launches);

    await runtime.startSession({
      cwd: "/workspace/project",
      mcpConfigPath: "/tmp/paseo-pi-mcp/mcp.json",
    });

    expect(launches).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        mcpConfigPath: "/tmp/paseo-pi-mcp/mcp.json",
        argv: ["pi", "--mode", "rpc", "--mcp-config", "/tmp/paseo-pi-mcp/mcp.json"],
      }),
    ]);
  });

  test("uses the configured command when resuming a session", async () => {
    const child = createPiChild();
    replyToCommands(child, () => ({}));
    const launches: PiRuntimeLaunch[] = [];
    const runtime = new PiCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["pi"],
      runtimeSettings: {
        command: {
          mode: "replace",
          argv: ["omp"],
        },
      },
      spawnProcess: (launch) => {
        launches.push(launch);
        return child;
      },
    });

    await runtime.startSession({ cwd: "/workspace/project", session: "/tmp/omp-session.jsonl" });

    expect(launches).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        session: "/tmp/omp-session.jsonl",
        argv: ["omp", "--mode", "rpc", "--session", "/tmp/omp-session.jsonl"],
      }),
    ]);
  });

  test("passes an appended system prompt to Pi", async () => {
    const child = createPiChild();
    replyToCommands(child, () => ({}));
    const launches: PiRuntimeLaunch[] = [];
    const runtime = createRuntime(child, launches);

    await runtime.startSession({
      cwd: "/workspace/project",
      systemPrompt: "  Use the daemon prompt.  ",
    });

    expect(launches).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        systemPrompt: "Use the daemon prompt.",
        argv: ["pi", "--mode", "rpc", "--append-system-prompt", "Use the daemon prompt."],
      }),
    ]);
  });

  test("delivers events separately from command responses", async () => {
    const child = createPiChild();
    replyToCommands(child, () => ({ models: [] }));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    child.stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
    await session.getAvailableModels();

    expect(events).toEqual([{ type: "turn_start" }]);
  });

  test("lists commands through the default Pi get_commands RPC", async () => {
    const child = createPiChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        commands: [{ name: "review", description: "Review changes", source: "extension" }],
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await expect(session.getCommands()).resolves.toEqual([
      { name: "review", description: "Review changes", source: "extension" },
    ]);
    expect(commandTypes).toEqual(["get_commands"]);
  });

  test("lists commands through the OMP-compatible get_available_commands RPC", async () => {
    const child = createPiChild();
    const commandTypes: string[] = [];
    replyToCommands(child, (command) => {
      commandTypes.push(String(command.type));
      return {
        commands: [{ name: "skill:ctx-stats", description: "Show context stats", source: "skill" }],
      };
    });
    const session = await createRuntime(child, [], {
      commandsRpcType: "get_available_commands",
    }).startSession({ cwd: "/workspace/project" });

    await expect(session.getCommands()).resolves.toEqual([
      { name: "skill:ctx-stats", description: "Show context stats", source: "skill" },
    ]);
    expect(commandTypes).toEqual(["get_available_commands"]);
  });

  test("keeps unicode line separators inside one JSONL record", async () => {
    const child = createPiChild();
    replyToCommands(child, () => ({}));
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });
    const events: unknown[] = [];
    session.onEvent((event) => events.push(event));

    child.stdout.write(`${JSON.stringify({ type: "message", text: "a\u2028b\u2029c" })}\n`);

    expect(events).toEqual([{ type: "message", text: "a\u2028b\u2029c" }]);
  });

  test("rejects pending commands when the Pi process exits", async () => {
    const child = createPiChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const state = session.getState();
    child.stderr.write("boom");
    child.emit("exit", 1, null);

    await expect(state).rejects.toThrow("boom");
  });

  test("disposes the Pi process", async () => {
    const child = createPiChild();
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    await session.close();

    expect(child.killedSignals).toContain("SIGTERM");
  });

  test("falls back to get_state when get_session_stats is unsupported", async () => {
    const child = createPiChild();
    let commandSequence: string[] = [];
    replyToCommands(child, (command) => {
      commandSequence.push(String(command.type));
      if (command.type === "get_session_stats") {
        // Simulate older OMP binary that doesn't support this RPC
        throw new Error(`Unknown command: ${command.type}`);
      }
      // get_state returns contextUsage for fallback
      return {
        sessionId: "pi-session-1",
        thinkingLevel: "medium" as const,
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time" as const,
        followUpMode: "one-at-a-time" as const,
        interruptMode: "immediate" as const,
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases: [],
        contextUsage: { tokens: 1_100, contextWindow: 200_000 },
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const stats = await session.getSessionStats();

    expect(stats.contextUsage).toEqual({
      tokens: 1_100,
      contextWindow: 200_000,
    });
    expect(commandSequence).toEqual(["get_session_stats", "get_state"]);
  });

  test("returns full stats from get_session_stats without falling back", async () => {
    const child = createPiChild();
    let fallbackCalled = false;
    replyToCommands(child, (command) => {
      if (command.type === "get_state") {
        fallbackCalled = true;
      }
      return {
        tokens: { input: 500, output: 300, cacheRead: 100 },
        cost: 0.02,
        contextUsage: { tokens: 800, contextWindow: 200_000 },
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const stats = await session.getSessionStats();

    expect(stats).toMatchObject({
      tokens: { input: 500, output: 300, cacheRead: 100 },
      cost: 0.02,
      contextUsage: { tokens: 800, contextWindow: 200_000 },
    });
    // Should NOT have called get_state as a fallback
    expect(fallbackCalled).toBe(false);
  });

  test("does not fall back when get_session_stats returns cost:0", async () => {
    const child = createPiChild();
    let fallbackCalled = false;
    replyToCommands(child, (command) => {
      if (command.type === "get_state") {
        fallbackCalled = true;
      }
      return {
        tokens: { input: 200, output: 100 },
        cost: 0,
        contextUsage: { tokens: 500, contextWindow: 200_000 },
      };
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const stats = await session.getSessionStats();

    expect(stats.tokens).toEqual({ input: 200, output: 100 });
    expect(stats.cost).toBe(0);
    expect(stats.contextUsage).toEqual({ tokens: 500, contextWindow: 200_000 });
    // Should NOT have called get_state as a fallback
    expect(fallbackCalled).toBe(false);
  });

  test("returns empty object when both get_session_stats and get_state fail", async () => {
    const child = createPiChild();
    replyToCommands(child, (command) => {
      throw new Error(`Unknown command: ${command.type}`);
    });
    const session = await createRuntime(child).startSession({ cwd: "/workspace/project" });

    const stats = await session.getSessionStats();

    // Neither RPC returned usable data — should resolve with empty object
    expect(stats).toEqual({});
  });
});
