import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  __openCodeInternals,
  OpenCodeAgentClient,
  translateOpenCodeEvent,
} from "./opencode-agent.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";
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

async function collectTurnEvents(iterator: AsyncGenerator<AgentStreamEvent>): Promise<TurnResult> {
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

function isBinaryInstalled(binary: string): boolean {
  try {
    const out = execFileSync("which", [binary], { encoding: "utf8" }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const hasOpenCode = isBinaryInstalled("opencode");

(hasOpenCode ? describe : describe.skip)("OpenCodeAgentClient", () => {
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

    logger.info(
      { modelCount: models.length, elapsed: Date.now() - startTime },
      "beforeAll: Retrieved models",
    );

    // Prefer fast models for tests - nano models are typically fastest
    const fastModel = models.find(
      (m) =>
        m.id.includes("gpt-4.1-nano") ||
        m.id.includes("gpt-5-nano") ||
        m.id.includes("gpt-5.1-codex-mini") ||
        m.id.includes("gpt-4o-mini") ||
        m.id.includes("gpt-3.5") ||
        m.id.includes("free"),
    );

    if (fastModel) {
      TEST_MODEL = fastModel.id;
    } else if (models.length > 0) {
      // Fallback to any available model
      TEST_MODEL = models[0].id;
    } else {
      throw new Error(
        "No OpenCode models available. Please authenticate with a provider (e.g., set OPENAI_API_KEY).",
      );
    }

    logger.info(
      { model: TEST_MODEL, totalElapsed: Date.now() - startTime },
      "beforeAll: Selected OpenCode test model",
    );
  }, 30_000);

  test("creates a session with valid id and provider", async () => {
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(logger);
    const session = await client.createSession(buildConfig(cwd));

    // HARD ASSERT: Session has required fields
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.provider).toBe("opencode");

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("single turn completes with streaming deltas", async () => {
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(logger);
    const session = await client.createSession(buildConfig(cwd));

    const iterator = streamSession(session, "Say hello");
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
  }, 120_000);

  test("listModels returns models with required fields", async () => {
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
      expect(model.metadata).toMatchObject({
        providerId: expect.any(String),
        modelId: expect.any(String),
        contextWindowMaxTokens: expect.any(Number),
      });
    }
  }, 60_000);

  test("available modes include build and plan", async () => {
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(logger);
    const session = await client.createSession(buildConfig(cwd));

    const modes = await session.getAvailableModes();

    expect(modes.some((mode) => mode.id === "build")).toBe(true);
    expect(modes.some((mode) => mode.id === "plan")).toBe(true);

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("custom agents defined in opencode.json appear in available modes", async () => {
    const cwd = tmpCwd();
    writeFileSync(
      path.join(cwd, "opencode.json"),
      JSON.stringify({
        agent: {
          "paseo-test-custom": {
            description: "Custom agent defined for Paseo integration test",
            mode: "primary",
          },
        },
      }),
    );

    const client = new OpenCodeAgentClient(logger);
    const session = await client.createSession(buildConfig(cwd));

    const modes = await session.getAvailableModes();

    expect(modes.some((mode) => mode.id === "build")).toBe(true);
    expect(modes.some((mode) => mode.id === "plan")).toBe(true);

    const custom = modes.find((mode) => mode.id === "paseo-test-custom");
    expect(custom).toBeDefined();
    expect(custom!.label).toBe("Paseo-test-custom");
    expect(custom!.description).toBe("Custom agent defined for Paseo integration test");

    // System agents should not appear as selectable modes
    expect(modes.some((mode) => mode.id === "compaction")).toBe(false);
    expect(modes.some((mode) => mode.id === "summary")).toBe(false);
    expect(modes.some((mode) => mode.id === "title")).toBe(false);

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("plan mode blocks edits while build mode can write files", async () => {
    const cwd = tmpCwd();
    const planFile = path.join(cwd, "plan-mode-output.txt");
    const buildFile = path.join(cwd, "build-mode-output.txt");
    const client = new OpenCodeAgentClient(logger);

    const planSession = await client.createSession({
      ...buildConfig(cwd),
      modeId: "plan",
    });

    const planTurn = await collectTurnEvents(
      streamSession(
        planSession,
        "Create a file named plan-mode-output.txt in the current directory containing exactly hello.",
      ),
    );

    expect(planTurn.turnCompleted).toBe(true);
    expect(planTurn.turnFailed).toBe(false);
    expect(existsSync(planFile)).toBe(false);

    const planResponse = planTurn.assistantMessages.map((message) => message.text).join("");
    expect(planResponse.toLowerCase()).toContain("plan mode");

    await planSession.close();

    const buildSession = await client.createSession({
      ...buildConfig(cwd),
      modeId: "build",
    });

    const buildTurn = await collectTurnEvents(
      streamSession(
        buildSession,
        "Create a file named build-mode-output.txt in the current directory containing exactly hello.",
      ),
    );

    expect(buildTurn.turnCompleted).toBe(true);
    expect(buildTurn.turnFailed).toBe(false);
    expect(existsSync(buildFile)).toBe(true);
    expect(readFileSync(buildFile, "utf8")).toContain("hello");

    await buildSession.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 180_000);
});

describe("OpenCode adapter context-window normalization", () => {
  test("preserves provider catalog context limit in model metadata", () => {
    const definition = __openCodeInternals.buildOpenCodeModelDefinition(
      { id: "openai", name: "OpenAI" },
      "gpt-5",
      {
        name: "GPT-5",
        family: "gpt",
        limit: {
          context: 400_000,
          input: 200_000,
          output: 16_384,
        },
      },
    );

    expect(definition.metadata).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5",
      contextWindowMaxTokens: 400_000,
      limit: {
        context: 400_000,
        input: 200_000,
        output: 16_384,
      },
    });
  });

  test("resolves selected model context window from connected provider catalog data", () => {
    expect(
      __openCodeInternals.resolveOpenCodeSelectedModelContextWindow(
        {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              models: {
                "gpt-5": {
                  limit: {
                    context: 400_000,
                    output: 16_384,
                  },
                },
              },
            },
            {
              id: "anthropic",
              models: {
                "claude-opus": {
                  limit: {
                    context: 1_000_000,
                    output: 8_192,
                  },
                },
              },
            },
          ],
        },
        "openai/gpt-5",
      ),
    ).toBe(400_000);

    expect(
      __openCodeInternals.resolveOpenCodeSelectedModelContextWindow(
        {
          connected: ["openai"],
          all: [
            {
              id: "anthropic",
              models: {
                "claude-opus": {
                  limit: {
                    context: 1_000_000,
                    output: 8_192,
                  },
                },
              },
            },
          ],
        },
        "anthropic/claude-opus",
      ),
    ).toBeUndefined();
  });

  test("normalizes step-finish usage into AgentUsage context window fields", () => {
    const usage = { contextWindowMaxTokens: 400_000 };

    __openCodeInternals.mergeOpenCodeStepFinishUsage(usage, {
      cost: 0.25,
      tokens: {
        total: 999_999,
        input: 30_000,
        output: 12_000,
        reasoning: 10_000,
        cache: {
          read: 2_000,
          write: 1_000,
        },
      },
    });

    expect(usage).toEqual({
      contextWindowMaxTokens: 400_000,
      contextWindowUsedTokens: 55_000,
      cachedInputTokens: 2_000,
      inputTokens: 30_000,
      outputTokens: 12_000,
      totalCostUsd: 0.25,
    });
    expect(__openCodeInternals.hasNormalizedOpenCodeUsage(usage)).toBe(true);
  });

  test("resolves context window max tokens from assistant message metadata", () => {
    const usage = {};
    const onAssistantModelContextWindowResolved = vi.fn();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-5",
          },
        },
      },
      {
        sessionId: "session-1",
        messageRoles: new Map(),
        accumulatedUsage: usage,
        streamedPartKeys: new Set(),
        emittedStructuredMessageIds: new Set(),
        partTypes: new Map(),
        modelContextWindowsByModelKey: new Map([["openai/gpt-5", 400_000]]),
        onAssistantModelContextWindowResolved,
      },
    );

    expect(onAssistantModelContextWindowResolved).toHaveBeenCalledWith(400_000);
  });
});
