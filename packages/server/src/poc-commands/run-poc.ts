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
  console.log(`\n=== Executing command: /${commandName} ===`);

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
      console.log(`  [${message.type}]`, message.type === "system" ? message.subtype : "");

      if (message.type === "system" && message.subtype === "init") {
        gotSystemInit = true;
        console.log("    Session:", message.session_id);
        console.log("    Model:", message.model);
      }

      if (message.type === "assistant") {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              console.log("    Response:", block.text.slice(0, 200) + (block.text.length > 200 ? "..." : ""));
            }
          }
        }
      }

      if (message.type === "result") {
        console.log("    Result:", message.subtype);
        break;
      }
    }
  } finally {
    input.end();
    await claudeQuery.return?.();
  }
}

async function main() {
  console.log("=== Claude Agent SDK Commands POC ===\n");

  // PART 1: List available commands using supportedCommands()
  console.log("=== Part 1: List Available Commands ===\n");

  try {
    const commands = await listAvailableCommands();

    console.log(`Found ${commands.length} commands:\n`);
    commands.forEach((cmd, index) => {
      console.log(`  ${index + 1}. /${cmd.name}`);
      console.log(`     Description: ${cmd.description}`);
      if (cmd.argumentHint) {
        console.log(`     Arguments: ${cmd.argumentHint}`);
      }
      console.log("");
    });

    // PART 2: Demonstrate command execution (optional - uncomment to test)
    // Commands are just prompts sent with / prefix
    console.log("=== Part 2: Command Execution Explanation ===");
    console.log("");
    console.log("Commands are executed by sending them as prompts with / prefix.");
    console.log("For example, to execute the 'help' command:");
    console.log('  1. Create a user message with content: "/help"');
    console.log("  2. Push it to the input stream");
    console.log("  3. Iterate the query to receive responses");
    console.log("");

    // Actually execute a command to demonstrate it works:
    // Using "context" as it's fast and doesn't require arguments
    await executeCommand("context");

  } catch (error) {
    console.error("ERROR:", error);
    process.exit(1);
  }

  console.log("=== POC Complete ===");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
