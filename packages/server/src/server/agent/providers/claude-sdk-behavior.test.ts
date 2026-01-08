/**
 * Direct SDK behavior tests - uses same setup as claude-agent.ts
 */
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

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

describe("Claude SDK direct behavior", () => {
  it("shows what happens after interrupt()", async () => {
    const cwd = tmpCwd();
    const input = new Pushable<SDKUserMessage>();

    // Use same options as claude-agent.ts
    const q = query({
      prompt: input,
      options: {
        cwd,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        settingSources: ["user", "project"],
        stderr: (data: string) => {
          console.error("[SDK stderr]", data.trim());
        },
      },
    });

    try {
      // Send first message
      console.log("[SDK] Sending MSG1");
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
        console.log("[SDK] MSG1 event:", event.type);

        if (event.type === "assistant") {
          // Push MSG2 BEFORE interrupt (like our wrapper does when a new message comes in)
          console.log("[SDK] Pushing MSG2 before interrupt...");
          input.push({
            type: "user",
            message: { role: "user", content: "Say exactly: MESSAGE_TWO" },
            parent_tool_use_id: null,
            session_id: "",
          });
          console.log("[SDK] Calling interrupt()...");
          await q.interrupt();
          console.log("[SDK] interrupt() returned");
          break;
        }
        if (event.type === "result") {
          console.log("[SDK] MSG1 completed before interrupt");
          break;
        }
      }

      console.log("[SDK] MSG1 events:", msg1Events.length);

      // MSG2 was already pushed before interrupt
      console.log("[SDK] About to call q.next() for MSG2...");
      const msg2Events: SDKMessage[] = [];
      for await (const event of q) {
        msg2Events.push(event);

        let detail = "";
        if (event.type === "assistant" && "message" in event && event.message?.content) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                detail = `"${block.text.substring(0, 50)}"`;
              }
            }
          }
        }
        console.log("[SDK] MSG2 event:", event.type, detail);

        if (event.type === "result") {
          break;
        }
      }
      console.log("[SDK] MSG2 loop finished");

      // Analyze response
      let responseText = "";
      for (const event of msg2Events) {
        if (event.type === "assistant" && "message" in event && event.message?.content) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                responseText += block.text;
              }
            }
          }
        }
      }

      console.log("[SDK] MSG2 response:", responseText);
      console.log("[SDK] Mentions 'one':", responseText.toLowerCase().includes("one"));
      console.log("[SDK] Mentions 'two':", responseText.toLowerCase().includes("two"));

      expect(msg2Events.some(e => e.type === "result")).toBe(true);
    } finally {
      input.end();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120000);
});
