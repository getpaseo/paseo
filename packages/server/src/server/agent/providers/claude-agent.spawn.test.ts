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
import { createExternalCommandProcessEnv } from "../../paseo-env.js";
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
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      {
        env: {
          ELECTRON_RUN_AS_NODE: "0",
          PASEO_AGENT_ID: "agent-123",
          PASEO_NODE_ENV: "production",
        },
      },
    );

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {
          ELECTRON_RUN_AS_NODE: "0",
          ELECTRON_NO_ATTACH_CONSOLE: "1",
          PASEO_DESKTOP_MANAGED: "1",
        },
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toBe(process.execPath);
    const command = spawnSpy.mock.calls[0]?.[0] ?? "";
    const spawnOptions = spawnSpy.mock.calls[0]?.[2];
    const env = createExternalCommandProcessEnv(
      command,
      spawnOptions?.baseEnv ?? process.env,
      spawnOptions?.envOverlay ?? {},
    );
    expect(spawnOptions?.shell).toBe(false);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env.PASEO_NODE_ENV).toBeUndefined();
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
  });

  test("scrubs Electron node mode when spawning an external Claude binary", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: Parameters<typeof query>[0]) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-spawn-external-env-session",
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
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      {
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          PASEO_AGENT_ID: "agent-123",
          PASEO_SUPERVISED: "1",
        },
      },
    );

    try {
      await session.run("spawn external env regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "/usr/local/bin/claude",
        args: ["--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ATTACH_CONSOLE: "1",
          NODE_ENV: "development",
          PASEO_DESKTOP_MANAGED: "1",
        },
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toBe("/usr/local/bin/claude");
    const command = spawnSpy.mock.calls[0]?.[0] ?? "";
    const spawnOptions = spawnSpy.mock.calls[0]?.[2];
    const env = createExternalCommandProcessEnv(
      command,
      spawnOptions?.baseEnv ?? process.env,
      spawnOptions?.envOverlay ?? {},
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
  });
});
