import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import { isProviderAvailable } from "../../../daemon-e2e/agent-configs.js";
import { ClaudeAgentClient } from "./agent.js";

// Real-Claude contract coverage: validates slash command shape from a live Claude CLI session.
describe("claude agent commands contract (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isProviderAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("lists slash commands with the expected contract", async () => {
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
        const typed = command;
        expect(typeof typed.name).toBe("string");
        expect(typed.name.length).toBeGreaterThan(0);
        expect(typed.name.startsWith("/")).toBe(false);
        expect(typeof typed.description).toBe("string");
        expect(typeof typed.argumentHint).toBe("string");
      }
    } finally {
      await session.close();
    }
  }, 60_000);
});
