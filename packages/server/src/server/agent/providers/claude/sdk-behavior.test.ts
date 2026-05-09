/**
 * Direct SDK behavior tests - uses same setup as the Claude provider
 */
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isProviderAvailable } from "../../../daemon-e2e/agent-configs.js";
import { findExecutable } from "../../../../utils/executable.js";
import { claudeQuery } from "./query.js";

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-behavior-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function rmCwd(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
      throw error;
    }
  }
}

function extractTextFromEvents(events: SDKMessage[]): string {
  let responseText = "";
  for (const event of events) {
    if (event.type !== "assistant" || !("message" in event) || !event.message?.content) {
      continue;
    }
    const content = event.message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        responseText += block.text;
      }
    }
  }
  return responseText;
}

describe("Claude SDK direct behavior", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("shows what happens after interrupt()", async () => {
    const cwd = tmpCwd();
    const input = new Pushable<SDKUserMessage>();
    const claudeBinary = await findExecutable("claude");

    // Use same options as the Claude provider
    const q = claudeQuery({
      prompt: input,
      options: {
        cwd,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        settingSources: ["user", "project"],
      },
    });

    try {
      // Send first message
      input.push({
        type: "user",
        message: { role: "user", content: "Say exactly: MESSAGE_ONE" },
        parent_tool_use_id: null,
        session_id: "",
      });

      // Collect events until we see assistant, then interrupt
      const msg1Events: SDKMessage[] = [];
      for await (const event of q) {
        msg1Events.push(event);

        if (event.type === "assistant") {
          // Push MSG2 BEFORE interrupt (like our wrapper does when a new message comes in)
          input.push({
            type: "user",
            message: { role: "user", content: "Say exactly: MESSAGE_TWO" },
            parent_tool_use_id: null,
            session_id: "",
          });
          await q.interrupt();
          break;
        }
        if (event.type === "result") {
          break;
        }
      }

      // MSG2 was already pushed before interrupt
      const msg2Events: SDKMessage[] = [];
      for await (const event of q) {
        msg2Events.push(event);

        if (event.type === "result") {
          break;
        }
      }

      // Analyze response
      const responseText = extractTextFromEvents(msg2Events);

      const sawResult = msg2Events.some((event) => event.type === "result");
      // The SDK may short-circuit after interrupt without a result event.
      expect(sawResult || responseText.length === 0).toBe(true);
    } finally {
      input.end();
      rmCwd(cwd);
    }
  }, 120000);
});
