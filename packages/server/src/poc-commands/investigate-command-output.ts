#!/usr/bin/env npx tsx

/**
 * Investigation: What does command execution actually return?
 *
 * This script logs ALL message types and their full structure
 * to understand how command output is delivered.
 */

import {
  query,
  type SDKUserMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T, void>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

async function investigateCommand(commandName: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Investigating: /${commandName}`);
  console.log("=".repeat(60));

  const input = new Pushable<SDKUserMessage>();

  const claudeQuery = query({
    prompt: input,
    options: {
      cwd: process.cwd(),
      permissionMode: "plan",
      includePartialMessages: true, // Include streaming partial messages
      settingSources: ["user", "project"],
    },
  });

  try {
    const userMessage: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content: `/${commandName}`,
      },
      parent_tool_use_id: null,
      session_id: "",
    };

    input.push(userMessage);

    let messageCount = 0;
    for await (const message of claudeQuery) {
      messageCount++;
      console.log(`\n--- Message ${messageCount} ---`);
      console.log(`Type: ${message.type}`);

      // Log the full structure based on type
      switch (message.type) {
        case "system":
          console.log(`Subtype: ${message.subtype}`);
          if (message.subtype === "init") {
            console.log(`Session: ${message.session_id}`);
            console.log(`Model: ${message.model}`);
          }
          break;

        case "user":
          console.log(`User message content:`, JSON.stringify(message.message?.content, null, 2));
          break;

        case "assistant":
          console.log(`Assistant message content:`);
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              console.log(`  Block type: ${block.type}`);
              if (block.type === "text") {
                console.log(`  Text: ${block.text}`);
              } else if (block.type === "tool_use") {
                console.log(`  Tool: ${block.name}`);
                console.log(`  Input: ${JSON.stringify(block.input, null, 2)}`);
              } else {
                console.log(`  Full block: ${JSON.stringify(block, null, 2)}`);
              }
            }
          } else {
            console.log(`  Content: ${JSON.stringify(content, null, 2)}`);
          }
          break;

        case "stream_event":
          console.log(`Stream event type: ${message.event?.type}`);
          if (message.event?.type === "content_block_delta") {
            const delta = message.event.delta;
            if (delta?.type === "text_delta") {
              console.log(`  Text delta: ${delta.text}`);
            }
          }
          break;

        case "result":
          console.log(`Result subtype: ${message.subtype}`);
          if ("errors" in message && message.errors) {
            console.log(`Errors: ${JSON.stringify(message.errors)}`);
          }
          // Check for any other properties
          const resultKeys = Object.keys(message).filter(k => !["type", "subtype"].includes(k));
          if (resultKeys.length > 0) {
            console.log(`Other result properties: ${resultKeys.join(", ")}`);
            for (const key of resultKeys) {
              console.log(`  ${key}: ${JSON.stringify((message as any)[key], null, 2)}`);
            }
          }
          break;

        default:
          console.log(`Full message: ${JSON.stringify(message, null, 2)}`);
      }

      if (message.type === "result") {
        break;
      }
    }

    console.log(`\nTotal messages received: ${messageCount}`);

  } finally {
    input.end();
    await claudeQuery.return?.();
  }
}

async function main() {
  console.log("=== Command Output Investigation ===\n");

  // Test /context - a local command that shows context info
  await investigateCommand("context");

  // Test /cost - another local command
  await investigateCommand("cost");

  // Test /prompt-engineer - a SKILL (not a local command)
  await investigateCommand("prompt-engineer");

  console.log("\n=== Investigation Complete ===");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
