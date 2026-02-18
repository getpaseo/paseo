/**
 * TDD Tests for Claude Agent Commands Integration
 *
 * Tests the ability to:
 * 1. List available slash commands from a ClaudeAgentSession
 *
 * These tests verify that the agent abstraction layer properly exposes
 * the Claude Agent SDK's command capabilities.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentSession, AgentSessionConfig, AgentSlashCommand } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";

const hasClaudeCredentials =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

(hasClaudeCredentials ? describe : describe.skip)("ClaudeAgentSession Commands", () => {
  let client: ClaudeAgentClient;
  let session: AgentSession;

  // Mock config for testing - uses plan mode to avoid actual tool execution
  const testConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: process.cwd(),
    modeId: "plan",
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
      expect(commandNames).toContain("rewind");

      await session.close();
    }, 30000);
  });

});
