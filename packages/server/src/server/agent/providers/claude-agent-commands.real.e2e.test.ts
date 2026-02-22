import { describe, expect, test } from "vitest";
import pino from "pino";

import { isCommandAvailable } from "../provider-launch-config.js";
import type { AgentSlashCommand } from "../agent-sdk-types.js";
import { ClaudeAgentClient } from "./claude-agent.js";

// Real-Claude contract coverage: validates slash command shape from a live Claude CLI session.
describe("claude agent commands contract (real)", () => {
  test(
    "lists slash commands with the expected contract",
    async () => {
      expect(isCommandAvailable("claude")).toBe(true);

      const client = new ClaudeAgentClient({
        logger: pino({ level: "silent" }),
      });
      const session = await client.createSession({
        provider: "claude",
        cwd: process.cwd(),
        modeId: "plan",
      });

      try {
        expect(typeof session.listCommands).toBe("function");
        const commands = await session.listCommands!();

        expect(Array.isArray(commands)).toBe(true);
        expect(commands.length).toBeGreaterThan(0);
        expect(commands.map((command) => command.name)).toContain("rewind");

        for (const command of commands) {
          const typed = command as AgentSlashCommand;
          expect(typeof typed.name).toBe("string");
          expect(typed.name.length).toBeGreaterThan(0);
          expect(typed.name.startsWith("/")).toBe(false);
          expect(typeof typed.description).toBe("string");
          expect(typeof typed.argumentHint).toBe("string");
        }
      } finally {
        await session.close();
      }
    },
    60_000
  );
});
