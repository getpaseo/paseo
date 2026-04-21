import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  query,
  type Options,
  type Query,
  type SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../utils/spawn.js";
import { ClaudeAgentClient } from "./claude-agent.js";

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
  return {
    stderr: new EventEmitter(),
  } as ChildProcess;
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("bypasses the shell when spawning Claude Code", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: Parameters<typeof query>[0]) => {
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

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnOptions = spawnSpy.mock.calls[0]?.[2];
    expect(spawnOptions?.shell).toBe(false);
  });
});
