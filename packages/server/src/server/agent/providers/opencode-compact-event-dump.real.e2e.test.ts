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

  test("compacts the existing native session through the provider API", async () => {
    const cwd = tmpCwd();
    const client = createRealProviderClient("opencode", logger);

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "build",
      });

      try {
        const seed = await session.run("Reply with exactly: COMPACT_SEED_OK");
        const nativeSessionId = seed.sessionId;

        const compactEvents: AgentStreamEvent[] = [];
        const unsubscribe = session.subscribe((event) => {
          compactEvents.push(event);
        });
        try {
          await session.compact?.();
        } finally {
          unsubscribe();
        }

        dumpCompactEvents(compactEvents);

        expect(session.describePersistence?.()?.sessionId).toBe(nativeSessionId);
        expect(
          compactEvents.some(
            (event) =>
              event.type === "timeline" &&
              event.item.type === "compaction" &&
              event.item.status === "completed",
          ),
        ).toBe(true);
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
