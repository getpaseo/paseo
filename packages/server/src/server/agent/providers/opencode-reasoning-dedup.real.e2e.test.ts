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

describe("OpenCode reasoning dedup", () => {
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

  test("reasoning content is not duplicated as assistant_message", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "opencode-reasoning-dedup-"));
    const client = createRealProviderClient("opencode", logger);

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        model: OPENCODE_REAL_TEST_MODEL,
        modeId: "build",
      });

      const streamedEvents: AgentStreamEvent[] = [];
      session.subscribe((event) => {
        streamedEvents.push(event);
      });

      await session.run("What is 2+2? Think step by step.");

      const reasoningTexts: string[] = [];
      const assistantTexts: string[] = [];

      for (const event of streamedEvents) {
        if (event.type === "timeline") {
          if (event.item.type === "reasoning") {
            reasoningTexts.push(event.item.text);
          } else if (event.item.type === "assistant_message") {
            assistantTexts.push(event.item.text);
          }
        }
      }

      const fullReasoningText = reasoningTexts.join("");
      const fullAssistantText = assistantTexts.join("");

      // The model should produce reasoning
      expect(reasoningTexts.length).toBeGreaterThan(0);
      expect(fullReasoningText.length).toBeGreaterThan(0);

      // The assistant text should be the response, not the reasoning
      expect(assistantTexts.length).toBeGreaterThan(0);

      // Reasoning text must NOT appear in the assistant text
      const reasoningPrefix = fullReasoningText.slice(0, 50);
      if (reasoningPrefix.length > 10) {
        expect(fullAssistantText).not.toContain(reasoningPrefix);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
