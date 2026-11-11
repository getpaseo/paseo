import { expect, test } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The injected SDK adapter consumes real session input and holds a command open
// until the test releases it. Closing the query interrupts that command.
class ForegroundQuery {
  readonly work = deferred<void>();
  readonly closed = deferred<void>();
  private stopped = false;
  private readonly output: AsyncGenerator<SDKMessage>;

  constructor(input: ClaudeQueryInput) {
    this.output = this.events(input);
  }

  private async *events(input: ClaudeQueryInput): AsyncGenerator<SDKMessage> {
    if (typeof input.prompt === "string") throw new Error("Expected streaming input");
    for await (const _prompt of input.prompt) {
      yield {
        type: "system",
        subtype: "init",
        session_id: "settings-session",
        model: "claude-haiku-5-5",
        permissionMode: "auto",
      } as SDKMessage;
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool_sleep", name: "Bash", input: { command: "sleep 20" } },
          ],
        },
      } as SDKMessage;
      await this.work.promise;
      if (this.stopped) return;
      yield { type: "assistant", message: { content: "DONE" } } as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        total_cost_usd: 0,
      } as SDKMessage;
    }
  }

  next() {
    return this.output.next();
  }
  return() {
    this.close();
    return this.output.return();
  }
  close() {
    this.stopped = true;
    this.closed.resolve();
    this.work.resolve();
  }
  async interrupt() {
    this.close();
  }
  async setPermissionMode() {}
  async setModel() {}
  async supportedCommands() {
    return [];
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

test.each(["mode", "model", "commands"] as const)(
  "a pending thinking change preserves the current turn during a %s request",
  async (control) => {
    const queries: ForegroundQuery[] = [];
    const efforts: ClaudeQueryInput["options"]["effort"][] = [];
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude",
      queryFactory: (input) => {
        const query = new ForegroundQuery(input);
        queries.push(query);
        efforts.push(input.options.effort);
        return query as unknown as Query;
      },
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-haiku-5-5",
      modeId: "auto",
      thinkingOptionId: "low",
    });
    const running = deferred<void>();
    let terminal = deferred<string>();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.status === "running"
      )
        running.resolve();
      if (
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      )
        terminal.resolve(event.type);
    });
    try {
      await session.startTurn("Run the foreground command");
      await running.promise;
      expect(await session.setThinkingOption?.("medium")).toMatchObject({
        message: "Thinking level applies next turn",
      });
      if (control === "mode") await session.setMode("acceptEdits");
      else if (control === "model") await session.setModel("claude-sonnet-5-6");
      else await session.listCommands();
      queries[0].work.resolve();
      expect(
        await Promise.race([
          terminal.promise,
          queries[0].closed.promise.then(() => "query closed before turn finished"),
        ]),
      ).toBe("turn_completed");
      expect(
        events.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "assistant_message" &&
            event.item.text === "DONE",
        ),
      ).toBe(true);

      terminal = deferred<string>();
      await session.startTurn("Run another command with the new thinking level");
      queries[1].work.resolve();
      expect(await terminal.promise).toBe("turn_completed");
      expect(efforts).toEqual(["low", "medium"]);
    } finally {
      await session.close();
    }
  },
);
