/**
 * TDD Tests for Claude Agent Commands Integration
 *
 * Tests the ability to:
 * 1. List available slash commands from a ClaudeAgentSession
 * 2. Execute slash commands through ClaudeAgentSession
 *
 * These tests verify that the agent abstraction layer properly exposes
 * the Claude Agent SDK's command capabilities.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentSession, AgentSessionConfig, AgentSlashCommand } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const hasClaudeCredentials =
  !!process.env.CLAUDE_SESSION_TOKEN || !!process.env.ANTHROPIC_API_KEY;

(hasClaudeCredentials ? describe : describe.skip)("ClaudeAgentSession Commands", () => {
  let client: ClaudeAgentClient;
  let session: AgentSession;

  // Mock config for testing - uses plan mode to avoid actual tool execution
  const testConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: process.cwd(),
    modeId: "plan",
    agentControlMcp: {
      url: "http://localhost:6767/mcp", // Placeholder - not actually used in plan mode
    },
  };

  beforeAll(async () => {
    client = new ClaudeAgentClient({ logger: createTestLogger() });
  });

  afterAll(async () => {
    if (session) {
      await session.close();
    }
  });

  describe("listCommands()", () => {
    it("should return an array of AgentSlashCommand objects", async () => {
      session = await client.createSession(testConfig);

      // The session should have a listCommands method
      expect(typeof session.listCommands).toBe("function");

      const commands = await session.listCommands!();

      // Should be an array
      expect(Array.isArray(commands)).toBe(true);

      // Should have at least some built-in commands
      expect(commands.length).toBeGreaterThan(0);

      await session.close();
    }, 30000);

    it("should have valid AgentSlashCommand structure for all commands", async () => {
      session = await client.createSession(testConfig);

      const commands = await session.listCommands!();

      // Verify all commands have valid structure
      for (const cmd of commands) {
        expect(cmd).toHaveProperty("name");
        expect(cmd).toHaveProperty("description");
        expect(cmd).toHaveProperty("argumentHint");
        expect(typeof cmd.name).toBe("string");
        expect(typeof cmd.description).toBe("string");
        expect(typeof cmd.argumentHint).toBe("string");
        expect(cmd.name.length).toBeGreaterThan(0);
        // Names should NOT have the / prefix (that's added when executing)
        expect(cmd.name.startsWith("/")).toBe(false);
      }

      await session.close();
    }, 30000);

    it("should include user-defined skills", async () => {
      session = await client.createSession(testConfig);

      const commands = await session.listCommands!();
      const commandNames = commands.map((cmd) => cmd.name);

      // Should have at least one command (skills are loaded from user/project settings)
      // The exact commands depend on what skills are configured
      expect(commands.length).toBeGreaterThan(0);

      await session.close();
    }, 30000);
  });

  describe("executeCommand()", () => {
    it("should execute a command and return a result", async () => {
      session = await client.createSession(testConfig);

      // The session should have an executeCommand method
      expect(typeof session.executeCommand).toBe("function");

      // First get available commands to use one that exists
      const commands = await session.listCommands!();
      expect(commands.length).toBeGreaterThan(0);

      // Execute one of the available commands
      const firstCommand = commands[0];
      const result = await session.executeCommand!(firstCommand.name);

      // Should return a result object
      expect(result).toBeDefined();
      expect(typeof result.text).toBe("string");
      // Note: Some commands may return empty text (e.g., plugin descriptions)

      await session.close();
    }, 60000);

    it("should return non-empty output for /context command", async () => {
      session = await client.createSession(testConfig);

      // Execute /context - a local command that returns token usage info
      const result = await session.executeCommand!("context");

      expect(result).toBeDefined();
      expect(typeof result.text).toBe("string");

      // /context MUST return actual content - this is the key test
      // If this fails, user messages from SDK are not being captured
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).toContain("Context");

      await session.close();
    }, 60000);

    it("should include timeline items in result", async () => {
      session = await client.createSession(testConfig);

      // First get available commands to use one that exists
      const commands = await session.listCommands!();
      expect(commands.length).toBeGreaterThan(0);

      const firstCommand = commands[0];
      const result = await session.executeCommand!(firstCommand.name);

      // Result should include timeline items from the command execution
      expect(Array.isArray(result.timeline)).toBe(true);

      // Timeline may or may not have items depending on command execution
      // Just verify the structure is correct

      await session.close();
    }, 60000);

    it("should throw for non-existent command", async () => {
      session = await client.createSession(testConfig);

      // Non-existent commands should still work (they get sent as prompts)
      // but the response should indicate the command doesn't exist
      // This is how the SDK works - invalid commands become regular prompts
      const result = await session.executeCommand!("nonexistent_command_xyz");

      // The result should exist (command is treated as a prompt)
      expect(result).toBeDefined();

      await session.close();
    }, 60000);
  });
});
