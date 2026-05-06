import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import { isCommandAvailable } from "../../../utils/executable.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";

describe("opencode agent commands contract (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isCommandAvailable("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("lists slash commands with the expected contract", async () => {
    expect(await isCommandAvailable("opencode")).toBe(true);

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

  test("executes a slash command without arguments", async () => {
    expect(await isCommandAvailable("opencode")).toBe(true);

    const client = new OpenCodeAgentClient(pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "opencode",
      cwd: process.cwd(),
      modeId: "plan",
    });

    try {
      const commands = await session.listCommands!();
      expect(commands.length).toBeGreaterThan(0);

      // Pick the first available command and send it without arguments.
      const command = commands[0];
      const events: Array<{ type: string }> = [];
      session.subscribe((event) => events.push(event));

      const { turnId } = await session.startTurn(`/${command.name}`);
      expect(turnId).toBeTruthy();

      // Wait for any terminal event OR a short timeout.
      // Some commands trigger full AI turns that may hang waiting for tool
      // permissions. The test only needs to verify the invocation path
      // doesn't crash with type errors on the `arguments` field.
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          unsub();
          resolve();
        }, 15_000);
        const unsub = session.subscribe((event) => {
          if (
            event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled"
          ) {
            clearTimeout(timeout);
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
