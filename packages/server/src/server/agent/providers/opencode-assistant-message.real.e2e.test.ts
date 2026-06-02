import { afterAll, beforeAll, beforeEach, describe, test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { OpenCodeServerManager } from "./opencode/server-manager.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";

const OPENCODE_REAL_TEST_MODEL = getRealProviderConfig("opencode").model;

describe("OpenCode assistant message", () => {
  let canRun = false;
  const logger = pino({ level: "silent" });

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

  test("assistant_message appears in live stream", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "opencode-msg-"));
    const client = createRealProviderClient("opencode", logger);

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "build",
      });

      const result = await session.run("Say hello back in one sentence.");

      const assistantItems = result.timeline.filter((item) => item.type === "assistant_message");
      expect(assistantItems.length).toBeGreaterThan(0);
      expect(result.finalText.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test("streamHistory returns assistant_message after a completed turn", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "opencode-history-"));
    const client = createRealProviderClient("opencode", logger);

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "build",
      });

      const result = await session.run("Say hello back in one sentence.");
      expect(result.timeline.some((item) => item.type === "assistant_message")).toBe(true);

      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }

      const historyAssistant = historyEvents.filter(
        (e) => e.type === "timeline" && e.item.type === "assistant_message",
      );
      expect(historyAssistant.length).toBeGreaterThan(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
