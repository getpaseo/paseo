import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createControlledClaudeQueryFactory(resultGate: Promise<void>) {
  return vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const queuedMessages: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    let closed = false;

    function wakeNextWaiter() {
      waiters.shift()?.();
    }

    function enqueue(message: Record<string, unknown>) {
      queuedMessages.push(message);
      wakeNextWaiter();
    }

    void (async () => {
      for await (const _message of prompt) {
        enqueue({
          type: "system",
          subtype: "init",
          session_id: "session-live-usage",
          permissionMode: "default",
          model: "claude-sonnet-4-6",
        });
        enqueue({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 20,
                cache_read_input_tokens: 30,
              },
            },
          },
          session_id: "session-live-usage",
        });
        enqueue({
          type: "stream_event",
          event: {
            type: "message_delta",
            usage: {
              output_tokens: 25,
            },
          },
          session_id: "session-live-usage",
        });
        await resultGate;
        enqueue({
          type: "result",
          subtype: "success",
          duration_ms: 100,
          duration_api_ms: 75,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: null,
          total_cost_usd: 0.25,
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 5,
            output_tokens: 7,
          },
          modelUsage: {
            "claude-sonnet-4-6": { contextWindow: 200_000 },
          },
          permission_denials: [],
          uuid: "result-live-usage",
          session_id: "session-live-usage",
        });
        break;
      }
      closed = true;
      wakeNextWaiter();
    })();

    return {
      next: vi.fn(async () => {
        for (;;) {
          if (queuedMessages.length > 0 || closed) {
            break;
          }
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
        if (queuedMessages.length === 0) {
          return { done: true, value: undefined };
        }
        return { done: false, value: queuedMessages.shift() };
      }),
      interrupt: vi.fn(async () => undefined),
      return: vi.fn(async () => {
        closed = true;
        wakeNextWaiter();
        return undefined;
      }),
      close: vi.fn(() => {
        closed = true;
        wakeNextWaiter();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getContextUsage: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
}

describe("daemon E2E (claude live usage)", () => {
  test("publishes renderable active context usage through agent_update", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-claude-live-usage-"));
    const resultGate = deferred();
    const daemon = await createTestPaseoDaemon({
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          queryFactory: createControlledClaudeQueryFactory(resultGate.promise),
          resolveBinary: async () => "/test/claude/bin",
        }),
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "claude-live-usage" } });

      const agent = await client.createAgent({
        provider: "claude",
        model: "claude-sonnet-4-6",
        cwd,
        title: "Claude live usage",
      });

      await client.sendMessage(agent.id, "Report live usage");

      const activeSnapshot = await client.waitForAgentUpsert(
        agent.id,
        (snapshot) =>
          snapshot.status === "running" &&
          snapshot.lastUsage?.contextWindowMaxTokens === 200_000 &&
          snapshot.lastUsage.contextWindowUsedTokens === 175,
        10_000,
      );

      expect(activeSnapshot.lastUsage).toEqual({
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 175,
      });

      resultGate.resolve();
      const finalState = await client.waitForFinish(agent.id, 10_000);
      expect(finalState.status).toBe("idle");
    } finally {
      resultGate.resolve();
      await client.close().catch(() => undefined);
      await daemon.close();
    }
  });
});
