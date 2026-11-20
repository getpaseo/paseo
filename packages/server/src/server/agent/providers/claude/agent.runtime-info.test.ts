import pino from "pino";
import { describe, expect, test } from "vitest";

import { ClaudeAgentClient } from "./agent.js";

describe("Claude runtime info before a turn", () => {
  const client = new ClaudeAgentClient({ logger: pino({ level: "silent" }) });

  test("reports the explicitly configured model before the first turn", async () => {
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      model: "claude-haiku-5-5",
    });
    try {
      expect(await session.getRuntimeInfo()).toMatchObject({ model: "claude-haiku-5-5" });
    } finally {
      await session.close();
    }
  });

  test("reports the persisted configured model after rebuilding an idle session", async () => {
    const session = await client.resumeSession({
      provider: "claude",
      sessionId: "runtime-model-before-turn",
      metadata: { cwd: process.cwd(), model: "claude-haiku-5-5" },
    });
    try {
      expect(await session.getRuntimeInfo()).toMatchObject({
        sessionId: "runtime-model-before-turn",
        model: "claude-haiku-5-5",
      });
      expect((await session.getRuntimeInfo()).model).toBe("claude-haiku-5-5");
      expect((await session.getRuntimeInfo()).extra?.runtimeModel).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("leaves the model unknown when Claude will choose its default", async () => {
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      expect((await session.getRuntimeInfo()).model).toBeNull();
    } finally {
      await session.close();
    }
  });
});
