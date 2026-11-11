import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { isPlatform } from "../../../../test-utils/platform.js";
import { claudeQuery, type ClaudeQueryContext, type ClaudeQueryInput } from "./query.js";

type SpawnProcess = NonNullable<ClaudeQueryContext["spawnProcess"]>;
type SpawnCall = Parameters<SpawnProcess>;

interface SpawnRecorder {
  calls: SpawnCall[];
  spawnProcess: SpawnProcess;
}

function createQueryStub(): Query {
  return {
    next: async () => ({ done: true, value: undefined }),
    return: async () => ({ done: true, value: undefined }),
    interrupt: async () => undefined,
    close: () => undefined,
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    supportedModels: async () => [],
    supportedCommands: async () => [],
    rewindFiles: async () => ({ canRewind: true }),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

function createSpawnRecorder(child: ChildProcess): SpawnRecorder {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
  };
}

function createSpawnHarness(
  spawnProcess: SpawnProcess,
  context: Partial<ClaudeQueryContext> = {},
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  let spawn: Options["spawnClaudeCodeProcess"];
  const queryFactory = ({ options }: ClaudeQueryInput) => {
    spawn = options.spawnClaudeCodeProcess;
    return createQueryStub();
  };
  claudeQuery(
    { prompt: "spawn regression", options: {} },
    { queryFactory, spawnProcess, ...context },
  );
  if (!spawn) {
    throw new Error("Claude spawn callback was not configured");
  }
  return spawn;
}

function findClaudeSpawnCall(calls: SpawnCall[]): SpawnCall {
  const call = calls.find(([, args]) => args[0] === "claude.js");
  if (!call) {
    throw new Error("Claude process was not spawned");
  }
  return call;
}

function spawnOptions(signal = new AbortController().signal): ClaudeSpawnOptions {
  return {
    command: "node",
    args: ["claude.js", "--mcp-config", JSON.stringify({ mcpServers: {} })],
    cwd: process.cwd(),
    env: {},
    signal,
  };
}

function removeConfigDirectories(paths: string[]): void {
  for (const path of paths) {
    rmSync(dirname(path), { recursive: true, force: true });
  }
}

describe("Claude spawn override", () => {
  test("spawns without a shell or inline MCP config", () => {
    const child = createChildProcessStub();
    const recorder = createSpawnRecorder(child);
    const spawn = createSpawnHarness(recorder.spawnProcess);
    const inlineMcpConfig = JSON.stringify({
      mcpServers: {
        paseo: {
          type: "http",
          headers: { Authorization: "synthetic-test-credential" },
        },
      },
    });

    spawn({ ...spawnOptions(), args: ["claude.js", "--mcp-config", inlineMcpConfig] });

    const [, args, processOptions] = findClaudeSpawnCall(recorder.calls);
    const mcpConfigIndex = args.indexOf("--mcp-config");
    expect(mcpConfigIndex).toBe(1);
    const mcpConfigPath = args[mcpConfigIndex + 1]!;
    try {
      expect(args).toEqual(["claude.js", "--mcp-config", mcpConfigPath]);
      expect(readFileSync(mcpConfigPath, "utf8")).toBe(inlineMcpConfig);
      expect(processOptions?.shell).toBe(false);
    } finally {
      child.emit("exit", 0, null);
    }
    expect(existsSync(mcpConfigPath)).toBe(false);
  });

  test.skipIf(isPlatform("win32"))("writes the MCP config with private permissions", () => {
    const child = createChildProcessStub();
    const recorder = createSpawnRecorder(child);
    const spawn = createSpawnHarness(recorder.spawnProcess);

    spawn(spawnOptions());

    const [, args] = findClaudeSpawnCall(recorder.calls);
    const mcpConfigPath = args[args.indexOf("--mcp-config") + 1]!;
    try {
      expect(statSync(mcpConfigPath).mode & 0o777).toBe(0o600);
    } finally {
      child.emit("exit", 0, null);
    }
  });

  test("removes the MCP config when spawning fails", () => {
    const configPaths: string[] = [];
    const spawn = createSpawnHarness((_command, args) => {
      configPaths.push(args[args.indexOf("--mcp-config") + 1]!);
      throw new Error("synthetic spawn failure");
    });

    try {
      expect(() => spawn(spawnOptions())).toThrow("synthetic spawn failure");
      expect(configPaths).toHaveLength(1);
      expect(existsSync(configPaths[0]!)).toBe(false);
    } finally {
      removeConfigDirectories(configPaths);
    }
  });

  test("removes the MCP config when spawning is canceled", () => {
    const child = createChildProcessStub();
    const recorder = createSpawnRecorder(child);
    const spawn = createSpawnHarness(recorder.spawnProcess);
    const controller = new AbortController();

    spawn(spawnOptions(controller.signal));
    const [, args] = findClaudeSpawnCall(recorder.calls);
    const mcpConfigPath = args[args.indexOf("--mcp-config") + 1]!;
    try {
      controller.abort();
      expect(existsSync(mcpConfigPath)).toBe(false);
    } finally {
      rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
    }
  });

  test("removes the MCP config when the child process errors", () => {
    const child = createChildProcessStub();
    const recorder = createSpawnRecorder(child);
    const spawn = createSpawnHarness(recorder.spawnProcess);

    spawn(spawnOptions());
    const [, args] = findClaudeSpawnCall(recorder.calls);
    const mcpConfigPath = args[args.indexOf("--mcp-config") + 1]!;
    try {
      child.emit("error", new Error("synthetic child error"));
      expect(existsSync(mcpConfigPath)).toBe(false);
    } finally {
      rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
    }
  });

  // chmod does not block removal on Windows, and root ignores directory modes.
  test.skipIf(isPlatform("win32") || process.getuid?.() === 0)(
    "does not throw from the exit or error listener when MCP config removal fails",
    () => {
      const records: Record<string, unknown>[] = [];
      const logger = pino(
        { level: "warn" },
        { write: (line: string) => records.push(JSON.parse(line) as Record<string, unknown>) },
      );
      const child = createChildProcessStub();
      const recorder = createSpawnRecorder(child);
      const spawn = createSpawnHarness(recorder.spawnProcess, { logger });
      const controller = new AbortController();
      const detachAbortListener = vi.spyOn(controller.signal, "removeEventListener");

      spawn(spawnOptions(controller.signal));
      const [, args] = findClaudeSpawnCall(recorder.calls);
      const mcpConfigPath = args[args.indexOf("--mcp-config") + 1]!;
      const configDir = dirname(mcpConfigPath);
      // Without write permission on the directory the recursive removal fails.
      chmodSync(configDir, 0o500);
      try {
        expect(() => child.emit("exit", 0, null)).not.toThrow();
        expect(records).toContainEqual(
          expect.objectContaining({
            level: pino.levels.values.warn,
            msg: "failed to remove Claude MCP config",
          }),
        );
        expect(detachAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
        // A second event must not retry the removal once permissions are back.
        chmodSync(configDir, 0o755);
        expect(() => child.emit("error", new Error("synthetic child error"))).not.toThrow();
        expect(existsSync(mcpConfigPath)).toBe(true);
      } finally {
        chmodSync(configDir, 0o755);
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );
});
