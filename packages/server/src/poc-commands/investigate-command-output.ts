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
  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`Investigating: /${commandName}\n`);
  process.stdout.write(`${"=".repeat(60)}\n`);

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
      process.stdout.write(`\n--- Message ${messageCount} ---\n`);
      process.stdout.write(`Type: ${message.type}\n`);

      // Log the full structure based on type
      switch (message.type) {
        case "system":
          process.stdout.write(`Subtype: ${message.subtype}\n`);
          if (message.subtype === "init") {
            process.stdout.write(`Session: ${message.session_id}\n`);
            process.stdout.write(`Model: ${message.model}\n`);
          }
          break;

        case "user":
          process.stdout.write(`User message content: ${JSON.stringify(message.message?.content, null, 2)}\n`);
          break;

        case "assistant":
          process.stdout.write("Assistant message content:\n");
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              process.stdout.write(`  Block type: ${block.type}\n`);
              if (block.type === "text") {
                process.stdout.write(`  Text: ${block.text}\n`);
              } else if (block.type === "tool_use") {
                process.stdout.write(`  Tool: ${block.name}\n`);
                process.stdout.write(`  Input: ${JSON.stringify(block.input, null, 2)}\n`);
              } else {
                process.stdout.write(`  Full block: ${JSON.stringify(block, null, 2)}\n`);
              }
            }
          } else {
            process.stdout.write(`  Content: ${JSON.stringify(content, null, 2)}\n`);
          }
          break;

        case "stream_event":
          process.stdout.write(`Stream event type: ${message.event?.type}\n`);
          if (message.event?.type === "content_block_delta") {
            const delta = message.event.delta;
            if (delta?.type === "text_delta") {
              process.stdout.write(`  Text delta: ${delta.text}\n`);
            }
          }
          break;

        case "result":
          process.stdout.write(`Result subtype: ${message.subtype}\n`);
          if ("errors" in message && message.errors) {
            process.stdout.write(`Errors: ${JSON.stringify(message.errors)}\n`);
          }
          // Check for any other properties
          const resultKeys = Object.keys(message).filter(k => !["type", "subtype"].includes(k));
          if (resultKeys.length > 0) {
            process.stdout.write(`Other result properties: ${resultKeys.join(", ")}\n`);
            for (const key of resultKeys) {
              process.stdout.write(`  ${key}: ${JSON.stringify((message as any)[key], null, 2)}\n`);
            }
          }
          break;

        default:
          process.stdout.write(`Full message: ${JSON.stringify(message, null, 2)}\n`);
      }

      if (message.type === "result") {
        break;
      }
    }

    process.stdout.write(`\nTotal messages received: ${messageCount}\n`);

  } finally {
    input.end();
    await claudeQuery.return?.();
  }
}

async function main() {
  process.stdout.write("=== Command Output Investigation ===\n\n");

  // Test /context - a local command that shows context info
  await investigateCommand("context");

  // Test /cost - another local command
  await investigateCommand("cost");

  // Test /prompt-engineer - a SKILL (not a local command)
  await investigateCommand("prompt-engineer");

  process.stdout.write("\n=== Investigation Complete ===\n");
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
