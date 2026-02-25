/**
 * TDD Tests for Claude Agent Commands Integration
 *
 * Tests the ability to:
 * 1. List available slash commands from a ClaudeAgentSession
 *
 * These tests verify that the agent abstraction layer properly exposes
 * the Claude Agent SDK's command capabilities.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ClaudeAgentClient } from "./claude-agent.js";
import type { AgentSession, AgentSessionConfig, AgentSlashCommand } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { useTempClaudeConfigDir } from "../../test-utils/claude-config.js";

const hasClaudeCredentials =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

(hasClaudeCredentials ? describe : describe.skip)("ClaudeAgentSession Commands", () => {
  let client: ClaudeAgentClient;
  let session: AgentSession | null = null;
  let commands: AgentSlashCommand[] = [];
  let restoreClaudeConfigDir: (() => void) | null = null;
  let tempCwd: string | null = null;

  const buildTestConfig = (cwd: string): AgentSessionConfig => ({
    provider: "claude",
    cwd,
    modeId: "plan",
  });

  beforeAll(async () => {
    restoreClaudeConfigDir = useTempClaudeConfigDir();
    const rawTempDir = mkdtempSync(path.join(os.tmpdir(), "claude-agent-commands-"));
    try {
      tempCwd = realpathSync(rawTempDir);
    } catch {
      tempCwd = rawTempDir;
    }
    client = new ClaudeAgentClient({ logger: createTestLogger() });
    session = await client.createSession(buildTestConfig(tempCwd));
    if (typeof session.listCommands !== "function") {
      throw new Error("Claude test session does not expose listCommands");
    }
    commands = await session.listCommands();
  });

  afterAll(async () => {
    try {
      if (session) {
        await session.close();
      }
    } finally {
      session = null;
      if (tempCwd) {
        rmSync(tempCwd, { recursive: true, force: true });
        tempCwd = null;
      }
      restoreClaudeConfigDir?.();
      restoreClaudeConfigDir = null;
    }
  });

  describe("listCommands()", () => {
    it("should return an array of AgentSlashCommand objects", async () => {
      if (!session) {
        throw new Error("Claude test session not initialized");
      }

      // The session should have a listCommands method
      expect(typeof session.listCommands).toBe("function");

      // Should be an array
      expect(Array.isArray(commands)).toBe(true);

      // Should have at least some built-in commands
      expect(commands.length).toBeGreaterThan(0);
    }, 30000);

    it("should have valid AgentSlashCommand structure for all commands", async () => {
      if (!session) {
        throw new Error("Claude test session not initialized");
      }

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
    }, 30000);

    it("should include user-defined skills", async () => {
      if (!session) {
        throw new Error("Claude test session not initialized");
      }

      const commandNames = commands.map((cmd) => cmd.name);

      // Should have at least one command (skills are loaded from user/project settings)
      // The exact commands depend on what skills are configured
      expect(commands.length).toBeGreaterThan(0);
      expect(commandNames).toContain("rewind");
    }, 30000);
  });

});
