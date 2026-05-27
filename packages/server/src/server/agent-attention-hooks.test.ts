import { spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";

import {
  createAgentAttentionHookRunner,
  type AgentAttentionHookPayload,
} from "./agent-attention-hooks.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function createLogger(): pino.Logger {
  const logger = {
    child: vi.fn(() => logger),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createChildProcess() {
  const handlers = new Map<string, (...values: unknown[]) => void>();
  const stdinHandlers = new Map<string, (...values: unknown[]) => void>();
  const child = {
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event: string, handler: (...values: unknown[]) => void) => {
        stdinHandlers.set(event, handler);
        return child.stdin;
      }),
      emit(event: string, ...values: unknown[]) {
        stdinHandlers.get(event)?.(...values);
      },
    },
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (...values: unknown[]) => void) => {
      handlers.set(event, handler);
      return child;
    }),
    emit(event: string, ...values: unknown[]) {
      handlers.get(event)?.(...values);
    },
  };
  return child;
}

const payload: AgentAttentionHookPayload = {
  agentId: "agent-1",
  provider: "codex",
  reason: "finished",
  notification: {
    title: "Agent finished",
    body: "Done.",
    data: {
      serverId: "srv-test",
      agentId: "agent-1",
      reason: "finished",
    },
  },
};

describe("AgentAttentionHookRunner", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  test("passes the attention payload to the configured command over stdin", async () => {
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const runner = createAgentAttentionHookRunner(createLogger(), {
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
    });

    const run = runner.run(payload);
    child.emit("close", 0);
    await run;

    expect(spawn).toHaveBeenCalledWith("node", ["/opt/paseo/serverchan-hook.mjs"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    expect(child.stdin.write).toHaveBeenCalledWith(`${JSON.stringify(payload)}\n`);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  test("logs and swallows non-zero hook exits", async () => {
    const logger = createLogger();
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const runner = createAgentAttentionHookRunner(logger, {
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
    });

    const run = runner.run(payload);
    child.emit("close", 1);
    await run;

    expect(logger.warn).toHaveBeenCalledWith(
      { code: 1, signal: undefined },
      "Agent attention hook exited unsuccessfully",
    );
  });

  test("logs and swallows hook start errors", async () => {
    const logger = createLogger();
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const runner = createAgentAttentionHookRunner(logger, {
      command: ["missing-command"],
    });
    const error = new Error("spawn missing-command ENOENT");

    const run = runner.run(payload);
    child.emit("error", error);
    await run;

    expect(logger.warn).toHaveBeenCalledWith(
      { err: error },
      "Failed to start agent attention hook",
    );
  });

  test("logs and swallows stdin write errors", async () => {
    const logger = createLogger();
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const runner = createAgentAttentionHookRunner(logger, {
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
    });
    const error = new Error("write EOF");

    const run = runner.run(payload);
    child.stdin.emit("error", error);
    await run;

    expect(logger.warn).toHaveBeenCalledWith(
      { err: error },
      "Failed to write agent attention hook payload",
    );
    expect(child.kill).toHaveBeenCalled();
  });

  test("uses a 5 second default timeout", async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const runner = createAgentAttentionHookRunner(createLogger(), {
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
    });

    const run = runner.run(payload);
    await vi.advanceTimersByTimeAsync(4999);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    child.emit("close", null, "SIGTERM");
    await run;

    expect(child.kill).toHaveBeenCalled();
  });

  test("kills the hook process after the configured timeout", async () => {
    vi.useFakeTimers();
    const child = createChildProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const runner = createAgentAttentionHookRunner(createLogger(), {
      command: ["node", "/opt/paseo/serverchan-hook.mjs"],
      timeoutMs: 50,
    });

    const run = runner.run(payload);
    await vi.advanceTimersByTimeAsync(50);
    child.emit("close", null, "SIGTERM");
    await run;

    expect(child.kill).toHaveBeenCalled();
  });
});
