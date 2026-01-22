import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { z } from "zod";
import {
  generateStructuredAgentResponse,
} from "./agent-response-loop.js";
import { AgentManager } from "./agent-manager.js";
import { createAllClients, shutdownProviders } from "./provider-registry.js";
import pino from "pino";

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("getStructuredAgentResponse (e2e)", () => {
  let manager: AgentManager;
  let cwd: string;

  beforeEach(async () => {
    cwd = mkdtempSync(path.join(tmpdir(), "agent-response-loop-"));
    const logger = pino({ level: "silent" });
    manager = new AgentManager({
      clients: createAllClients(logger),
      logger,
    });
  });

  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await shutdownProviders(pino({ level: "silent" }));
  }, 60000);

  test(
    "returns schema-valid JSON from a real Codex agent",
    async () => {
      const schema = z.object({
        title: z.string(),
        count: z.number(),
      });

      const result = await generateStructuredAgentResponse({
        manager,
        agentConfig: {
          provider: "codex",
          model: CODEX_TEST_MODEL,
          reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Structured Response Test",
        },
        prompt: "Return JSON with a short title and count 2.",
        schema,
        maxRetries: 1,
      });

      expect(result.title.length).toBeGreaterThan(0);
      expect(typeof result.count).toBe("number");
    },
    180000
  );
});
