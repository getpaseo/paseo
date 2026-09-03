import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
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
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }) as ChildProcess["kill"];
  return child;
}

const INIT_EVENT = {
  type: "system",
  subtype: "init",
  session_id: "claude-auth-failure-session",
  permissionMode: "default",
  model: "opus",
};

function failingTurn(error: string) {
  return [INIT_EVENT, { type: "result", subtype: "error_during_execution", errors: [error] }];
}

function createClient(events: unknown[]) {
  const queryFactory = vi.fn((_input: ClaudeQueryInput) => createQueryMock(events));
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  return { client, queryFactory };
}

describe("Claude auth failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("marks an expired credential so it is not mistaken for a crash", async () => {
    const { client } = createClient(
      failingTurn("Failed to authenticate: OAuth session expired and could not be refreshed"),
    );
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      await expect(session.run("hello")).rejects.toThrow(/Failed to authenticate/);

      const failure = events.find((event) => event.type === "turn_failed");
      expect(failure).toBeDefined();
      expect(failure && "authState" in failure ? failure.authState : undefined).toBe("expired");
    } finally {
      await session.close();
    }
  });

  test("leaves ordinary failures unflagged", async () => {
    const { client } = createClient(failingTurn("Tool call failed: ENOENT"));
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      await expect(session.run("hello")).rejects.toThrow(/ENOENT/);

      const failure = events.find((event) => event.type === "turn_failed");
      expect(failure).toBeDefined();
      expect(failure && "authState" in failure ? failure.authState : undefined).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("answers /login locally instead of forwarding it to a runtime that rejects it", async () => {
    const { client, queryFactory } = createClient([INIT_EVENT]);
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      await session.startTurn("/login");

      const message = events.find(
        (event) => event.type === "timeline" && event.item.type === "assistant_message",
      );
      expect(message).toBeDefined();
      const text =
        message && message.type === "timeline" && message.item.type === "assistant_message"
          ? message.item.text
          : "";
      expect(text).toContain("Claude Code");
      expect(text).toContain("/logout");
      expect(events.some((event) => event.type === "turn_completed")).toBe(true);
      // The point of the interception: never reaches the SDK.
      expect(queryFactory).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});
