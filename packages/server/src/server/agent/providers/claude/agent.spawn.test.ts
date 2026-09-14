import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
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

async function createSpawnHarness(): Promise<{
  spawn: NonNullable<Options["spawnClaudeCodeProcess"]>;
  close: () => Promise<void>;
}> {
  let capturedOptions: Options | undefined;
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    capturedOptions = options;
    return createQueryMock([
      {
        type: "system",
        subtype: "init",
        session_id: "claude-spawn-shell-regression-session",
        permissionMode: "default",
        model: "opus",
      },
      {
        type: "assistant",
        message: { content: "done" },
      },
      {
        type: "result",
        subtype: "success",
        usage: {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
        total_cost_usd: 0,
      },
    ]);
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
  await session.run("spawn shell regression");
  const spawn = capturedOptions?.spawnClaudeCodeProcess;
  if (!spawn) {
    await session.close();
    throw new Error("Claude spawn callback was not configured");
  }
  return { spawn, close: () => session.close() };
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("spawns without a shell or inline MCP config", async () => {
    const child = createChildProcessStub();
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    const harness = await createSpawnHarness();

    try {
      const inlineMcpConfig = JSON.stringify({
        mcpServers: {
          paseo: {
            type: "http",
            headers: { Authorization: "synthetic-test-credential" },
          },
        },
      });
      harness.spawn({
        command: "node",
        args: ["claude.js", "--mcp-config", inlineMcpConfig],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);

      const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
      expect(claudeSpawnCall).toBeDefined();
      const [, args, spawnOptions] = claudeSpawnCall!;
      const mcpConfigIndex = args.indexOf("--mcp-config");
      expect(mcpConfigIndex).toBeGreaterThan(-1);
      const mcpConfigPath = args[mcpConfigIndex + 1]!;
      expect(mcpConfigPath).not.toBe(inlineMcpConfig);
      expect(args).toEqual(["claude.js", "--mcp-config", mcpConfigPath]);
      expect(readFileSync(mcpConfigPath, "utf8")).toBe(inlineMcpConfig);
      if (process.platform !== "win32") {
        expect(statSync(mcpConfigPath).mode & 0o777).toBe(0o600);
      }
      expect(spawnOptions.shell).toBe(false);

      child.emit("exit", 0, null);
      expect(existsSync(mcpConfigPath)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test("removes the MCP config when spawning fails", async () => {
    let mcpConfigPath: string | undefined;
    vi.spyOn(spawnUtils, "spawnProcess").mockImplementation((_command, args) => {
      const configFlagIndex = args.indexOf("--mcp-config");
      mcpConfigPath = args[configFlagIndex + 1];
      throw new Error("synthetic spawn failure");
    });
    const harness = await createSpawnHarness();

    try {
      expect(() =>
        harness.spawn({
          command: "node",
          args: ["claude.js", "--mcp-config", JSON.stringify({ mcpServers: {} })],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        }),
      ).toThrow("synthetic spawn failure");
      expect(mcpConfigPath).toBeDefined();
      expect(existsSync(mcpConfigPath!)).toBe(false);
    } finally {
      if (mcpConfigPath) {
        rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
      }
      await harness.close();
    }
  });

  test("removes the MCP config when spawning is canceled", async () => {
    const child = createChildProcessStub();
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    const harness = await createSpawnHarness();
    const controller = new AbortController();
    let mcpConfigPath: string | undefined;

    try {
      harness.spawn({
        command: "node",
        args: ["claude.js", "--mcp-config", JSON.stringify({ mcpServers: {} })],
        cwd: process.cwd(),
        env: {},
        signal: controller.signal,
      });
      const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
      expect(claudeSpawnCall).toBeDefined();
      const args = claudeSpawnCall![1];
      mcpConfigPath = args[args.indexOf("--mcp-config") + 1];

      controller.abort();

      expect(existsSync(mcpConfigPath!)).toBe(false);
    } finally {
      if (mcpConfigPath) {
        rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
      }
      await harness.close();
    }
  });

  test("removes the MCP config when the child process errors", async () => {
    const child = createChildProcessStub();
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
    const harness = await createSpawnHarness();
    let mcpConfigPath: string | undefined;

    try {
      harness.spawn({
        command: "node",
        args: ["claude.js", "--mcp-config", JSON.stringify({ mcpServers: {} })],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      });
      const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
      expect(claudeSpawnCall).toBeDefined();
      const args = claudeSpawnCall![1];
      mcpConfigPath = args[args.indexOf("--mcp-config") + 1];

      child.emit("error", new Error("synthetic child error"));

      expect(existsSync(mcpConfigPath!)).toBe(false);
    } finally {
      if (mcpConfigPath) {
        rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
      }
      await harness.close();
    }
  });
});
