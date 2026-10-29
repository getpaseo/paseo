import pino from "pino";
import { expect, test } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";

// Explicit real-provider test: run separately from the default suite.
test("uses the active model context window after switching from a 1M model", async () => {
  const client = new ClaudeAgentClient({ logger: pino({ level: "silent" }) });
  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd(), model: "claude-haiku-4-5" },
    undefined,
    { persistSession: false },
  );
  try {
    for (const [model, maxTokens] of [
      ["claude-haiku-4-5", 200_000],
      ["claude-opus-5-5", 1_000_000],
      ["claude-haiku-4-5", 200_000],
    ] as const) {
      await session.setModel(model);
      const events = await collectSessionTurnEvents(
        session,
        "Reply with exactly: OK. Do not use tools.",
        { signal: AbortSignal.timeout(90_000) },
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "usage_updated",
          usage: expect.objectContaining({ contextWindowMaxTokens: maxTokens }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn_completed",
          usage: expect.objectContaining({ contextWindowMaxTokens: maxTokens }),
        }),
      );
    }
  } finally {
    await session.close();
  }
}, 300_000);
