/**
 * TDD Test Suite for Command Support POC
 *
 * This tests the ability to:
 * 1. Get available commands/skills from the Claude Agent SDK
 * 2. Execute commands (determine if they're just prompts or something else)
 *
 * Key findings from SDK analysis:
 * - `supportedCommands()` returns SlashCommand[] with name, description, argumentHint
 * - Commands are executed by sending them as prompts with / prefix
 * - The SDK init message includes `slash_commands: string[]` and `skills: string[]`
 *
 * IMPORTANT: Control methods like supportedCommands() work WITHOUT iterating the query first!
 * Use an empty async generator for the prompt when you just need control methods.
 * This pattern is used in claude-agent.ts listModels().
 */

import { describe, it, expect } from "vitest";
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

describe("Claude Agent SDK Commands POC", () => {
  describe("supportedCommands() API", () => {
    it("should return an array of SlashCommand objects", async () => {
      // Use the pattern from claude-agent.ts:
      // Create a query with empty prompt generator for control methods
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

        // Should be an array
        expect(Array.isArray(commands)).toBe(true);

        // Log what we found
        console.log(`[Test] Found ${commands.length} commands:`);
        commands.slice(0, 10).forEach((cmd) => {
          console.log(`  - /${cmd.name}: ${cmd.description} [${cmd.argumentHint}]`);
        });
        if (commands.length > 10) {
          console.log(`  ... and ${commands.length - 10} more`);
        }

        // Verify structure
        if (commands.length > 0) {
          const firstCommand = commands[0];
          expect(typeof firstCommand.name).toBe("string");
          expect(typeof firstCommand.description).toBe("string");
          expect(typeof firstCommand.argumentHint).toBe("string");
          expect(firstCommand.name.startsWith("/")).toBe(false);
        }
      } finally {
        if (typeof claudeQuery.return === "function") {
          try {
            await claudeQuery.return();
          } catch {
            // ignore shutdown errors
          }
        }
      }
    }, 30000);

    it("should have valid SlashCommand structure for all commands", async () => {
      const emptyPrompt = createEmptyPrompt();

      const claudeQuery = query({
        prompt: emptyPrompt,
        options: {
          cwd: process.cwd(),
          permissionMode: "plan",
          settingSources: ["user", "project"],
        },
      });

      try {
        const commands = await claudeQuery.supportedCommands();

        expect(commands.length).toBeGreaterThan(0);

        // Verify all commands have valid structure
        for (const cmd of commands) {
          expect(cmd).toHaveProperty("name");
          expect(cmd).toHaveProperty("description");
          expect(cmd).toHaveProperty("argumentHint");
          expect(typeof cmd.name).toBe("string");
          expect(typeof cmd.description).toBe("string");
          expect(typeof cmd.argumentHint).toBe("string");
          expect(cmd.name.length).toBeGreaterThan(0);
          expect(cmd.name.startsWith("/")).toBe(false);
        }
      } finally {
        await claudeQuery.return?.();
      }
    }, 30000);
  });

  describe("Command Execution", () => {
    it("should explain that commands are prompts with / prefix", () => {
      // This is a documentation test - commands ARE just prompts with / prefix
      // To execute a command:
      // 1. Create a user message with content: "/{commandName}"
      // 2. Push it to the input stream
      // 3. Iterate the query to receive responses

      // The SDK handles command expansion:
      // - Slash commands expand to their template content
      // - Skills invoke the Skill tool
      // - The model processes the expanded prompt like any other

      expect(true).toBe(true); // Documentation-only test
    });
  });
});
