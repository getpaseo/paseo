import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

describe("real claude: idle runtime cleanup and session crons", () => {
  let canRun = false;
  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });
  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  test("a runtime holding a session-only cron is kept until the cron is deleted", async () => {
    const logger = pino({ level: "silent" });
    const client = createRealProviderClient("claude", logger);
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-claude-session-cron-"));
    const session = await client.createSession({
      cwd,
      ...getRealProviderConfig("claude"),
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.run(
        "Call the CronCreate tool exactly once with cron '0 */6 * * *', recurring true, durable false, prompt 'say hi'. Then reply with exactly: DONE",
      );
      const cronResult = events.find(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name === "CronCreate" &&
          event.item.status === "completed",
      );
      expect(cronResult, JSON.stringify(events.slice(-5))).toBeDefined();
      expect(await session.canStopRuntime!()).toBe(false);

      await session.run(
        "Delete every scheduled cron job with the CronDelete tool. Then reply with exactly: DONE",
      );
      expect(await session.canStopRuntime!()).toBe(true);
    } finally {
      await session.close();
    }
  }, 240_000);

  test("a turn interrupted after it creates a session-only cron keeps the runtime", async () => {
    const logger = pino({ level: "silent" });
    const client = createRealProviderClient("claude", logger);
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-claude-session-cron-"));
    const session = await client.createSession({
      cwd,
      ...getRealProviderConfig("claude"),
    });
    const cronCreated = new Promise<void>((resolve) => {
      session.subscribe((event) => {
        if (
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.name === "CronCreate" &&
          event.item.status === "completed"
        )
          resolve();
      });
    });
    try {
      await session.startTurn(
        "Call the CronCreate tool exactly once with cron '0 */6 * * *', recurring true, durable false, prompt 'say hi'. Then run the Bash command 'sleep 120' in the foreground. Then reply with exactly: DONE",
      );
      await cronCreated;
      await session.interrupt();
      // The cancelled turn settles about a second after interrupt() resolves.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(await session.canStopRuntime!()).toBe(false);
    } finally {
      await session.close();
    }
  }, 240_000);
});
