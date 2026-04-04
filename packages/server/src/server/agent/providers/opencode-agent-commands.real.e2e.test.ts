import { describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentSlashCommand } from "../agent-sdk-types.js";
import { isCommandAvailable } from "../../../utils/executable.js";
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

  test("executes a slash command without arguments", async () => {
    expect(isCommandAvailable("opencode")).toBe(true);

    const client = new OpenCodeAgentClient(pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "default",
    });

    try {
      const commands = await session.listCommands!();
      expect(commands.length).toBeGreaterThan(0);

      // Pick the first available command and send it without arguments.
      const command = commands[0]!;
      const events: Array<{ type: string }> = [];
      session.subscribe((event) => events.push(event));

      const { turnId } = await session.startTurn(`/${command.name}`);
      expect(turnId).toBeTruthy();

      // Wait for the turn to complete or fail.
      await new Promise<void>((resolve) => {
        const unsub = session.subscribe((event) => {
          if (
            event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled"
          ) {
            unsub();
            resolve();
          }
        });
      });

      // The turn should not have failed with an "invalid_type" error on arguments.
      const failEvent = events.find((e) => e.type === "turn_failed");
      if (failEvent && "error" in failEvent) {
        expect(String(failEvent.error)).not.toContain("invalid_type");
        expect(String(failEvent.error)).not.toContain("expected string, received undefined");
      }
    } finally {
      await session.close();
    }
  }, 60_000);
});
