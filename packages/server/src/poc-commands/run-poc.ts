#!/usr/bin/env npx tsx

/**
 * POC Script: Claude Agent SDK Commands
 *
 * This script demonstrates how to:
 * 1. Get available slash commands/skills from the Claude Agent SDK
 * 2. Execute commands (they are prompts sent with / prefix)
 *
 * Key insight from existing claude-agent.ts:
 * - Control methods like supportedCommands() work WITHOUT iterating the query first
 * - Use an empty async generator for the prompt when you just want to call control methods
 * - Commands are executed by sending them as prompts with / prefix to a streaming query
 *
 * Usage: npx tsx src/poc-commands/run-poc.ts
 */

import {
  query,
  type Query,
  type SlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Pattern from claude-agent.ts listModels():
// Use an empty async generator when you just need control methods
function createEmptyPrompt(): AsyncGenerator<SDKUserMessage, void, undefined> {
  return (async function* empty() {})();
}

// Utility: Create a pushable stream for SDK input (for command execution demo)
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

async function listAvailableCommands(): Promise<SlashCommand[]> {
  // Use the pattern from claude-agent.ts listModels():
  // Create a query with an empty prompt generator to call control methods
  const emptyPrompt = createEmptyPrompt();

  const claudeQuery = query({
    prompt: emptyPrompt,
    options: {
      cwd: process.cwd(),
      permissionMode: "plan",
      includePartialMessages: false,
      settingSources: ["user", "project"], // Required to load skills
    },
  });

  try {
    // supportedCommands() is a control method - works without iterating
    const commands = await claudeQuery.supportedCommands();
    return commands;
  } finally {
    // Clean up
    if (typeof claudeQuery.return === "function") {
      try {
        await claudeQuery.return();
      } catch {
        // ignore shutdown errors
      }
    }
  }
}

async function executeCommand(commandName: string): Promise<void> {
  process.stdout.write(`\n=== Executing command: /${commandName} ===\n`);

  // For command execution, we need a proper input stream
  const input = new Pushable<SDKUserMessage>();

  const claudeQuery = query({
    prompt: input,
    options: {
      cwd: process.cwd(),
      permissionMode: "plan",
      includePartialMessages: false,
      settingSources: ["user", "project"],
    },
  });

  try {
    // Push the command as a user message with / prefix
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

    // Iterate the query to process the command
    let gotSystemInit = false;
    for await (const message of claudeQuery) {
      process.stdout.write(`  [${message.type}] ${message.type === "system" ? message.subtype : ""}\n`);

      if (message.type === "system" && message.subtype === "init") {
        gotSystemInit = true;
        process.stdout.write(`    Session: ${message.session_id}\n`);
        process.stdout.write(`    Model: ${message.model}\n`);
      }

      if (message.type === "assistant") {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              process.stdout.write(`    Response: ${block.text.slice(0, 200)}${block.text.length > 200 ? "..." : ""}\n`);
            }
          }
        }
      }

      if (message.type === "result") {
        process.stdout.write(`    Result: ${message.subtype}\n`);
        break;
      }
    }
  } finally {
    input.end();
    await claudeQuery.return?.();
  }
}

async function main() {
  process.stdout.write("=== Claude Agent SDK Commands POC ===\n\n");

  // PART 1: List available commands using supportedCommands()
  process.stdout.write("=== Part 1: List Available Commands ===\n\n");

  try {
    const commands = await listAvailableCommands();

    process.stdout.write(`Found ${commands.length} commands:\n\n`);
    commands.forEach((cmd, index) => {
      process.stdout.write(`  ${index + 1}. /${cmd.name}\n`);
      process.stdout.write(`     Description: ${cmd.description}\n`);
      if (cmd.argumentHint) {
        process.stdout.write(`     Arguments: ${cmd.argumentHint}\n`);
      }
      process.stdout.write("\n");
    });

    // PART 2: Demonstrate command execution (optional - uncomment to test)
    // Commands are just prompts sent with / prefix
    process.stdout.write("=== Part 2: Command Execution Explanation ===\n");
    process.stdout.write("\n");
    process.stdout.write("Commands are executed by sending them as prompts with / prefix.\n");
    process.stdout.write("For example, to execute the 'help' command:\n");
    process.stdout.write('  1. Create a user message with content: "/help"\n');
    process.stdout.write("  2. Push it to the input stream\n");
    process.stdout.write("  3. Iterate the query to receive responses\n");
    process.stdout.write("\n");

    // Actually execute a command to demonstrate it works:
    // Using "context" as it's fast and doesn't require arguments
    await executeCommand("context");

  } catch (error) {
    process.stderr.write(`ERROR: ${error}\n`);
    process.exit(1);
  }

  process.stdout.write("=== POC Complete ===\n");
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
