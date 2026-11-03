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
      const turn1 = {
        sawTerminal: false,
        type: null as string | null,
        error: null as string | null,
      };
      const turn1Started = Promise.withResolvers<void>();
      session.subscribe((event) => {
        if (event.type === "turn_started" && phase === 1) {
          turn1Started.resolve();
          return;
        }
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
          turn1.type = event.type;
          turn1.error = error ?? null;
          return;
        }
        terminal.resolve({ type: event.type, error });
      });

      await session.startTurn("Use bash to run: echo paseo-interrupt-probe-1");
      // The cancel has to land while the provider still owns the turn, so wait
      // for the turn to start before interrupting it.
      await turn1Started.promise;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await session.interrupt();

      // A turn that ended before the cancel arrived was never cancelled, so the
      // interrupt would have had nothing to do. Only a cancelled turn proves
      // the provider was still holding it.
      expect(turn1.sawTerminal).toBe(true);
      expect(turn1.type).toBe("turn_canceled");
      expect(turn1.error).toBeNull();

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
