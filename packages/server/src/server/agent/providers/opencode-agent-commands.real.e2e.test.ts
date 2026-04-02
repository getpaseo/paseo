import { describe, expect, test } from "vitest";
import pino from "pino";

import { isCommandAvailable } from "../provider-launch-config.js";
import type { AgentSlashCommand } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";

describe("opencode agent commands contract (real)", () => {
  test("lists slash commands with the expected contract", async () => {
    expect(isCommandAvailable("opencode")).toBe(true);

    const client = new OpenCodeAgentClient(pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "plan",
    });

    try {
      expect(typeof session.listCommands).toBe("function");
      const commands = await session.listCommands!();

      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);

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
  }, 60_000);
});
