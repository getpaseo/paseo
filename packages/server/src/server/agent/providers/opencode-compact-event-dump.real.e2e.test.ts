import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

const OPENCODE_REAL_TEST_MODEL = getRealProviderConfig("opencode").model;
const logger = pino({ level: "silent" });

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "opencode-compact-dump-"));
}

function waitForTurnToFinish(session: {
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for OpenCode compact turn to finish"));
    }, 60_000);
    unsubscribe = session.subscribe((event) => {
      if (
        event.type !== "turn_completed" &&
        event.type !== "turn_failed" &&
        event.type !== "turn_canceled"
      ) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      if (event.type === "turn_failed") {
        reject(new Error(event.error));
        return;
      }
      resolve();
    });
  });
}

function dumpCompactEvents(events: AgentStreamEvent[]): void {
  console.info(
    "OPENCODE_COMPACT_EVENT_DUMP",
    JSON.stringify(
      events.map((event) => ({
        type: event.type,
        turnId: "turnId" in event ? event.turnId : undefined,
        item: event.type === "timeline" ? event.item : undefined,
        usage: event.type === "turn_completed" ? event.usage : undefined,
      })),
      null,
      2,
    ),
  );
}

describe("OpenCode compact event dump (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("opencode");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  afterAll(async () => {
    await OpenCodeServerManager.getInstance(logger).shutdown();
  });

  test("dumps live events emitted by a real /compact turn", async () => {
    const cwd = tmpCwd();
    const client = createRealProviderClient("opencode", logger);

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "build",
      });

      await session.run("Reply with exactly: COMPACT_SEED_OK");

      const compactEvents: AgentStreamEvent[] = [];
      const unsubscribe = session.subscribe((event) => {
        compactEvents.push(event);
      });
      const compactFinished = waitForTurnToFinish(session);

      try {
        await session.startTurn("/compact");
        await compactFinished;
      } finally {
        unsubscribe();
      }

      dumpCompactEvents(compactEvents);

      expect(compactEvents.some((event) => event.type === "turn_completed")).toBe(true);
      expect(
        compactEvents.filter(
          (event) => event.type === "timeline" && event.item.type === "assistant_message",
        ),
      ).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
