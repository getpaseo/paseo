import { beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import type {
  AgentSessionConfig,
  AgentStreamEvent,
  ToolCallTimelineItem,
  AssistantMessageTimelineItem,
  UserMessageTimelineItem,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-agent-test-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

// Dynamic model selection - will be set in beforeAll
let TEST_MODEL: string | undefined;

interface TurnResult {
  events: AgentStreamEvent[];
  assistantMessages: AssistantMessageTimelineItem[];
  toolCalls: ToolCallTimelineItem[];
  allTimelineItems: AgentTimelineItem[];
  turnCompleted: boolean;
  turnFailed: boolean;
  error?: string;
}

async function collectTurnEvents(
  iterator: AsyncGenerator<AgentStreamEvent>
): Promise<TurnResult> {
  const result: TurnResult = {
    events: [],
    assistantMessages: [],
    toolCalls: [],
    allTimelineItems: [],
    turnCompleted: false,
    turnFailed: false,
  };

  for await (const event of iterator) {
    result.events.push(event);

    if (event.type === "timeline") {
      result.allTimelineItems.push(event.item);
      if (event.item.type === "assistant_message") {
        result.assistantMessages.push(event.item);
      } else if (event.item.type === "tool_call") {
        result.toolCalls.push(event.item);
      }
    }

    if (event.type === "turn_completed") {
      result.turnCompleted = true;
      break;
    }
    if (event.type === "turn_failed") {
      result.turnFailed = true;
      result.error = event.error;
      break;
    }
  }

  return result;
}

describe("OpenCodeAgentClient", () => {
  const logger = createTestLogger();
  const buildConfig = (cwd: string): AgentSessionConfig => ({
    provider: "opencode",
    cwd,
    model: TEST_MODEL,
  });

  beforeAll(async () => {
    const startTime = Date.now();
    logger.info("beforeAll: Starting model selection");

    const client = new OpenCodeAgentClient(logger);
    const models = await client.listModels();

    logger.info({ modelCount: models.length, elapsed: Date.now() - startTime }, "beforeAll: Retrieved models");

    // Prefer fast models for tests - nano models are typically fastest
    const fastModel = models.find((m) =>
      m.id.includes("gpt-4.1-nano") ||
      m.id.includes("gpt-5-nano") ||
      m.id.includes("gpt-5.1-codex-mini") ||
      m.id.includes("gpt-4o-mini") ||
      m.id.includes("gpt-3.5") ||
      m.id.includes("free")
    );

    if (fastModel) {
      TEST_MODEL = fastModel.id;
    } else if (models.length > 0) {
      // Fallback to any available model
      TEST_MODEL = models[0].id;
    } else {
      throw new Error("No OpenCode models available. Please authenticate with a provider (e.g., set OPENAI_API_KEY).");
    }

    logger.info({ model: TEST_MODEL, totalElapsed: Date.now() - startTime }, "beforeAll: Selected OpenCode test model");
  }, 30_000);

  test(
    "creates a session with valid id and provider",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient(logger);
      const session = await client.createSession(buildConfig(cwd));

      // HARD ASSERT: Session has required fields
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
      expect(session.provider).toBe("opencode");

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    60_000
  );

  test(
    "single turn completes with streaming deltas",
    async () => {
      const cwd = tmpCwd();
      const client = new OpenCodeAgentClient(logger);
      const session = await client.createSession(buildConfig(cwd));

      const iterator = session.stream("Say hello");
      const turn = await collectTurnEvents(iterator);

      // HARD ASSERT: Turn completed successfully
      expect(turn.turnCompleted).toBe(true);
      expect(turn.turnFailed).toBe(false);

      // HARD ASSERT: Got at least one assistant message
      expect(turn.assistantMessages.length).toBeGreaterThan(0);

      // HARD ASSERT: Each delta is non-empty
      for (const msg of turn.assistantMessages) {
        expect(msg.text.length).toBeGreaterThan(0);
      }

      // HARD ASSERT: Concatenated deltas form non-empty response
      const fullResponse = turn.assistantMessages.map((m) => m.text).join("");
      expect(fullResponse.length).toBeGreaterThan(0);

      await session.close();
      rmSync(cwd, { recursive: true, force: true });
    },
    120_000
  );

  test(
    "listModels returns models with required fields",
    async () => {
      const client = new OpenCodeAgentClient(logger);
      const models = await client.listModels();

      // HARD ASSERT: Returns an array
      expect(Array.isArray(models)).toBe(true);

      // HARD ASSERT: At least one model is returned (OpenCode has connected providers)
      expect(models.length).toBeGreaterThan(0);

      // HARD ASSERT: Each model has required fields with correct types
      for (const model of models) {
        expect(model.provider).toBe("opencode");
        expect(typeof model.id).toBe("string");
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.label).toBe("string");
        expect(model.label.length).toBeGreaterThan(0);

        // HARD ASSERT: Model ID contains provider prefix (format: providerId/modelId)
        expect(model.id).toContain("/");
      }
    },
    60_000
  );

});
