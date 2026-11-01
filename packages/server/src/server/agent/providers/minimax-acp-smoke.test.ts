import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

/**
 * Live smoke against the real MiniMax Code binary, exactly like
 * cursor-acp-smoke.test.ts: skipped unless MINIMAX_ACP_SMOKE=1 because it
 * launches a real provider process and spends real tokens.
 *
 * Reproduces the production stuck-turn incident: a turn is canceled mid-flight,
 * and the next prompt must be accepted instead of rejected with the provider's
 * "Session already has an active Turn" (-32603).
 */
const runMinimaxACPSmoke = process.env.MINIMAX_ACP_SMOKE === "1" ? describe : describe.skip;

runMinimaxACPSmoke("MiniMax Code ACP live smoke", () => {
  test("a prompt after a mid-flight cancel is accepted, not rejected as an active turn", async () => {
    const client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["mcode", "acp"],
    });
    const session = await client.createSession({
      provider: "acp",
      cwd: process.cwd(),
    });

    try {
      const terminal = Promise.withResolvers<{ type: string; error?: string }>();
      let phase: 1 | 2 = 1;
      const turn1 = { sawTerminal: false, error: null as string | null };
      session.subscribe((event) => {
        if (
          event.type !== "turn_completed" &&
          event.type !== "turn_failed" &&
          event.type !== "turn_canceled"
        ) {
          return;
        }
        const error = event.type === "turn_failed" ? event.error : undefined;
        if (phase === 1) {
          turn1.sawTerminal = true;
          turn1.error = error ?? null;
          return;
        }
        terminal.resolve({ type: event.type, error });
      });

      await session.startTurn("Use bash to run: echo paseo-interrupt-probe-1");
      // Let the provider actually start, then cancel mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await session.interrupt();
      expect(turn1.sawTerminal).toBe(true);

      phase = 2;
      await session.startTurn("Use bash to run: echo paseo-interrupt-probe-2");
      const turn2 = await Promise.race([
        terminal.promise,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 120_000)),
      ]);
      expect(turn2).not.toBe("timeout");
      expect(turn2).toMatchObject({ type: expect.not.stringContaining("turn_failed") });
    } finally {
      await session.close();
    }
  }, 240_000);
});
