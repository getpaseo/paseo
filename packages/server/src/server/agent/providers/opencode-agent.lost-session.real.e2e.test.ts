import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

async function runTurn(session: AgentSession, prompt: string): Promise<AgentStreamEvent> {
  for await (const event of streamSession(session, prompt)) {
    if (isTerminalEvent(event)) return event;
  }
  throw new Error("turn ended without a terminal event");
}

describe("opencode agent whose native session is gone (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  test("a resumed agent whose OpenCode session no longer exists continues in a new session", async () => {
    const client = createRealProviderClient("opencode", pino({ level: "silent" }));
    const config = { ...getRealProviderConfig("opencode"), cwd: process.cwd() };

    // A non-persistent session deletes its native OpenCode session on close, which
    // leaves the handle naming a session OpenCode no longer has.
    const lost = await client.createSession(config, undefined, { persistSession: false });
    const handle = lost.describePersistence();
    await lost.close();
    expect(handle).not.toBeNull();

    const resumed = await client.resumeSession(handle!, config);
    try {
      const turn = await runTurn(resumed, "Reply with exactly: OK");

      expect(turn).toMatchObject({ type: "turn_completed" });
      expect(resumed.describePersistence()?.sessionId).not.toBe(handle!.sessionId);
    } finally {
      await resumed.close().catch(() => undefined);
    }
  }, 120_000);
});
