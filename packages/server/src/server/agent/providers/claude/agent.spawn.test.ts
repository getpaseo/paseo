import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  query as sdkQuery,
  type Options,
  type Query,
  type SpawnOptions as ClaudeSpawnOptions,
  type SpawnedProcess,
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

function createChildProcessStub(): ChildProcess & { killSignals: (NodeJS.Signals | number)[] } {
  const child = new EventEmitter() as ChildProcess & {
    killSignals: (NodeJS.Signals | number)[];
  };
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.killSignals = [];
  // A real child dies when signalled; without this teardown waits out its timeouts.
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killSignals.push(signal ?? "SIGTERM");
    child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const SPAWN_OPTIONS: ClaudeSpawnOptions = {
  command: "node",
  args: ["claude.js"],
  cwd: process.cwd(),
  env: {},
  signal: new AbortController().signal,
};

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

  test("keeps the Paseo MCP bearer token off the Claude Code command line", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([]);
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      resolveVersion: async () => "2.1.326",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          headers: { Authorization: "Bearer secret-token" },
        },
      },
    });
    await (session as unknown as { ensureQuery(): Promise<unknown> }).ensureQuery();
    await session.close();
    if (!capturedOptions) {
      throw new Error("Claude query options were not captured");
    }

    // Feed Paseo's options to the real SDK and record the argv it would launch with.
    let launchArgs: string[] | undefined;
    let stdinText = "";
    const stdin = new PassThrough();
    stdin.on("data", (chunk: Buffer) => {
      stdinText += chunk.toString("utf8");
    });
    const abortController = new AbortController();
    const sdk = sdkQuery({
      prompt: "hello",
      options: {
        ...capturedOptions,
        abortController,
        spawnClaudeCodeProcess: (spawnOptions: ClaudeSpawnOptions): SpawnedProcess => {
          launchArgs = spawnOptions.args;
          const child = new EventEmitter() as EventEmitter & SpawnedProcess;
          Object.assign(child, {
            stdin,
            stdout: new PassThrough(),
            killed: false,
            exitCode: null,
            kill: () => true,
          });
          return child;
        },
      },
    });
    // The fake process never answers, so the first message never arrives; only the launch matters.
    void sdk.next().catch(() => undefined);
    await vi.waitFor(() => {
      expect(stdinText).toContain("secret-token");
    });
    abortController.abort();

    expect(launchArgs).toBeDefined();
    expect(launchArgs?.join(" ")).not.toContain("secret-token");
    expect(launchArgs).not.toContain("--mcp-config");
  });

  test("starts Claude Code behind the session's launch wrap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-launch-wrap-"));
    const launcher = path.join(root, "launcher.mjs");
    await writeFile(launcher, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    let capturedOptions: Options | undefined;
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: ({ options }: ClaudeQueryInput) => {
        capturedOptions = options;
        return createQueryMock([]);
      },
      resolveBinary: async () => "/test/claude/bin",
      resolveVersion: async () => "2.1.326",
    });
    const session = await client.createSession(
      { provider: "claude", cwd: root },
      { wrap: [process.execPath, launcher, "--sandbox"] },
    );
    try {
      await (session as unknown as { ensureQuery(): Promise<unknown> }).ensureQuery();
      const child = capturedOptions?.spawnClaudeCodeProcess?.({
        command: "/test/claude/bin",
        args: ["--output-format", "stream-json"],
        cwd: root,
        env: {},
        signal: new AbortController().signal,
      }) as ChildProcess | undefined;
      if (!child?.stdout) throw new Error("Claude Code was not spawned");
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      await new Promise((resolve) => child.once("close", resolve));
      expect(JSON.parse(stdout)).toEqual([
        "--sandbox",
        "/test/claude/bin",
        "--output-format",
        "stream-json",
      ]);
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("two concurrent launches share one Claude process, and close tears it down", async () => {
  // Reopening a chat lists its commands from both the app and plugins simultaneously.
  // Both are control-plane reads going through the same lazy launch. Without a single-flight
  // guard each spawned its own `claude`, and `close()` only tracked the second child: the first
  // one, and every MCP server under it, outlived the session.
  const launchedOptions: Options[] = [];
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    launchedOptions.push(options);
    return createQueryMock([]);
  });
  const child = createChildProcessStub();
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

  try {
    const [first, second] = await Promise.all([session.listCommands!(), session.listCommands!()]);
    expect(first).toEqual(second);
    expect(queryFactory).toHaveBeenCalledTimes(1);

    // Spawn through the same port production uses, once per launched query.
    for (const options of launchedOptions) options.spawnClaudeCodeProcess?.(SPAWN_OPTIONS);
    expect(launchedOptions).toHaveLength(1);
  } finally {
    await session.close();
  }

  expect(child.killSignals.length).toBeGreaterThan(0);
});

test("a launch a restart superseded is retired before the caller runs on it", async () => {
  // `resolveThinkingConfig` reads the settings once, before the launch's options are fixed. A
  // setting written while that launch is in flight — a model or thinking switch, a rewind — is not
  // in it. Callers waiting on the launch must not run their turn on the stale options: the shared
  // launch is retired and replaced once, still single-flight.
  const launchedOptions: Options[] = [];
  let releaseLaunch: (() => void) | undefined;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let resolveBinaryEntered: (() => void) | undefined;
  const resolveBinaryStarted = new Promise<void>((resolve) => {
    resolveBinaryEntered = resolve;
  });
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    launchedOptions.push(options);
    return createQueryMock([]);
  });
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => {
      resolveBinaryEntered?.();
      await launchGate;
      return "/test/claude/bin";
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

  try {
    const first = session.listCommands!();
    await resolveBinaryStarted;
    await session.setThinkingOption!("high");
    const second = session.listCommands!();
    releaseLaunch?.();
    await Promise.all([first, second]);

    // The second launch is the one the setting asked for; the first ran on what it superseded.
    expect(launchedOptions.map((options) => options.effort)).toEqual([undefined, "high"]);
    expect(queryFactory).toHaveBeenCalledTimes(2);
  } finally {
    releaseLaunch?.();
    await session.close();
  }
});

test("a restart requested before the first launch does not spawn a second Claude", async () => {
  // The thinking and model setters mark a restart even when no query exists yet. The first launch
  // reads those settings, so its options already carry them: treating the mark as pending would
  // retire the fresh query and spawn a second `claude`.
  const launchedOptions: Options[] = [];
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    launchedOptions.push(options);
    return createQueryMock([]);
  });
  const child = createChildProcessStub();
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

  try {
    await session.setThinkingOption!("high");
    const [first, second] = await Promise.all([session.listCommands!(), session.listCommands!()]);

    expect(first).toEqual(second);
    expect(launchedOptions.map((options) => options.effort)).toEqual(["high"]);
    expect(queryFactory).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
  }
});

test("a launch that throws does not leave the session refusing option changes", async () => {
  // A queryFactory that throws — or options the SDK rejects — must still clear the launch flag,
  // otherwise `applyOptions` refuses every non-live option change for the rest of the session.
  let launches = 0;
  const launchedOptions: Options[] = [];
  const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
    launches += 1;
    launchedOptions.push(options);
    if (launches === 1) throw new Error("claude could not start");
    return createQueryMock([]);
  });
  const child = createChildProcessStub();
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });

  try {
    await expect(session.listCommands!()).rejects.toThrow("claude could not start");

    // Non-live options apply on the next launch, so this must not be refused.
    await expect(session.applyOptions!({ allowedTools: ["Read"] })).resolves.toBeUndefined();
    // A later launch works, and it carries the change.
    await expect(session.listCommands!()).resolves.toContainEqual(
      expect.objectContaining({ name: "rewind" }),
    );
    expect(queryFactory).toHaveBeenCalledTimes(2);
    expect(launchedOptions.at(-1)?.allowedTools).toEqual(["Read"]);
  } finally {
    await session.close();
  }
});
