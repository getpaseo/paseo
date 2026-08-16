import { EventEmitter } from "node:events";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
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
import type { ProviderWorkspace } from "../../agent-sdk-types.js";
import type { ProviderWorkspaceLaunchInput } from "../workspace/index.js";

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
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bypasses the shell when spawning Claude Code", async () => {
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
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
    expect(claudeSpawnCall).toBeDefined();
    const spawnOptions = claudeSpawnCall?.[2];
    expect(spawnOptions?.shell).toBe(false);
  });

  test("forwards the Claude SDK abort signal into selected workspace placement", async () => {
    let capturedOptions: Options | undefined;
    let resolveLaunch!: (launch: ProviderWorkspaceLaunchInput) => void;
    const launched = new Promise<ProviderWorkspaceLaunchInput>((resolve) => {
      resolveLaunch = resolve;
    });
    const child = createChildProcessStub() as ChildProcessWithoutNullStreams;
    const workspace = {
      cwd: ".",
      async resolveExecutable(command: string) {
        return command;
      },
      launchDeferred(input: ProviderWorkspaceLaunchInput | Promise<ProviderWorkspaceLaunchInput>) {
        void Promise.resolve(input).then(resolveLaunch);
        return child;
      },
    } as ProviderWorkspace;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([]);
    });
    const client = new ClaudeAgentClient({ logger: createTestLogger(), queryFactory });
    const session = await client.createSession(
      { provider: "claude", cwd: process.cwd() },
      { agentId: "selected-claude", workspace },
    );
    const controller = new AbortController();

    try {
      await session.listCommands?.();
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js"],
        cwd: process.cwd(),
        env: {},
        signal: controller.signal,
      } satisfies ClaudeSpawnOptions);
      await expect(launched).resolves.toMatchObject({ signal: controller.signal });
    } finally {
      child.emit("exit", 0, null);
      await session.close();
    }
  });
});
