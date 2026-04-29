import { beforeAll, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
} from "@opencode-ai/sdk/v2/client";
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
    const models = await client.listModels({ cwd: os.homedir(), force: false });

    logger.info(
      { modelCount: models.length, elapsed: Date.now() - startTime },
      "beforeAll: Retrieved models",
    );

    // Prefer cheap models that support tool use (required by OpenCode agents).
    // Avoid free-tier OpenRouter models — they often lack tool-use support.
    const fastModel = models.find(
      (m) =>
        m.id.includes("gpt-4.1-nano") ||
        m.id.includes("gpt-4.1-mini") ||
        m.id.includes("gpt-5-nano") ||
        m.id.includes("gpt-5.4-mini") ||
        m.id.includes("gpt-4o-mini"),
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
    const models = await client.listModels({ cwd: os.homedir(), force: false });

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
      });
      if (model.metadata.contextWindowMaxTokens !== undefined) {
        expect(model.metadata.contextWindowMaxTokens).toEqual(expect.any(Number));
      }
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

    const planResponse = planTurn.assistantMessages
      .map((message) => message.text)
      .join("")
      .trim();
    expect(planResponse.length).toBeGreaterThan(0);

    await planSession.close();

    const buildSession = await client.createSession({
      ...buildConfig(cwd),
      modeId: "build",
    });

    const buildTurn = await collectTurnEvents(
      streamSession(
        buildSession,
        "Use a file editing tool to create a file named build-mode-output.txt in the current directory containing exactly hello.",
      ),
    );

    expect(buildTurn.turnCompleted).toBe(true);
    expect(buildTurn.turnFailed).toBe(false);
    expect(existsSync(buildFile)).toBe(true);

    const buildResponse = buildTurn.assistantMessages
      .map((message) => message.text)
      .join("")
      .trim();
    expect(buildResponse.length).toBeGreaterThan(0);

    await buildSession.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 180_000);
});

describe("OpenCode adapter context-window normalization", () => {
  test("maps persisted OpenCode messages into Paseo timeline items", () => {
    const timeline = __openCodeInternals.mapOpenCodePersistedMessagesToTimeline([
      {
        info: {
          id: "user-message",
          sessionID: "session-1",
          role: "user",
        } as unknown as OpenCodeMessage,
        parts: [
          {
            id: "user-part-1",
            sessionID: "session-1",
            messageID: "user-message",
            type: "text",
            text: "Please ",
          },
          {
            id: "user-part-2",
            sessionID: "session-1",
            messageID: "user-message",
            type: "text",
            text: "continue",
          },
        ] as unknown as OpenCodePart[],
      },
      {
        info: {
          id: "assistant-message",
          sessionID: "session-1",
          role: "assistant",
        } as unknown as OpenCodeMessage,
        parts: [
          {
            id: "reasoning-part",
            sessionID: "session-1",
            messageID: "assistant-message",
            type: "reasoning",
            text: "Thinking",
            time: { start: 1, end: 2 },
          },
          {
            id: "assistant-part",
            sessionID: "session-1",
            messageID: "assistant-message",
            type: "text",
            text: "Done",
          },
        ] as unknown as OpenCodePart[],
      },
    ]);

    expect(timeline).toEqual([
      { type: "user_message", text: "Please continue" },
      { type: "reasoning", text: "Thinking" },
      { type: "assistant_message", text: "Done" },
    ]);
  });

  test("uses structured assistant content when persisted text parts are absent", () => {
    const timeline = __openCodeInternals.mapOpenCodePersistedMessagesToTimeline([
      {
        info: {
          id: "assistant-message",
          sessionID: "session-1",
          role: "assistant",
          structured: { result: "ok" },
        } as unknown as OpenCodeMessage,
        parts: [] as OpenCodePart[],
      },
    ]);

    expect(timeline).toEqual([{ type: "assistant_message", text: '{"result":"ok"}' }]);
  });

  test("ignores empty incomplete persisted assistant placeholders", () => {
    const timeline = __openCodeInternals.mapOpenCodePersistedMessagesToTimeline([
      {
        info: {
          id: "assistant-message",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1_777_217_640_000 },
        } as unknown as OpenCodeMessage,
        parts: [] as OpenCodePart[],
      },
    ]);

    expect(timeline).toEqual([]);
  });

  test("normalizes OpenCode second and millisecond timestamps", () => {
    expect(__openCodeInternals.normalizeOpenCodeTimestampMs(1_777_217_640)).toBe(1_777_217_640_000);
    expect(__openCodeInternals.normalizeOpenCodeTimestampMs(1_777_217_640_000)).toBe(
      1_777_217_640_000,
    );
    expect(__openCodeInternals.normalizeOpenCodeTimestampMs(undefined)).toBe(0);
  });

  test("extracts model, mode, and thinking option from the latest persisted message", () => {
    const state = __openCodeInternals.extractOpenCodePersistedSessionState([
      {
        info: {
          id: "older-message",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1_777_217_640_000 },
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
          agent: "plan",
          variant: "low",
        } as unknown as OpenCodeMessage,
        parts: [] as OpenCodePart[],
      },
      {
        info: {
          id: "newer-message",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1_777_217_650_000 },
          providerID: "openai",
          modelID: "gpt-5.5",
          mode: "build",
          agent: "build",
          variant: "medium",
        } as unknown as OpenCodeMessage,
        parts: [] as OpenCodePart[],
      },
    ]);

    expect(state).toEqual({
      model: "openai/gpt-5.5",
      modeId: "build",
      thinkingOptionId: "medium",
    });
  });

  test("normalizes persisted default OpenCode mode to build", () => {
    const state = __openCodeInternals.extractOpenCodePersistedSessionState([
      {
        info: {
          id: "user-message",
          sessionID: "session-1",
          role: "user",
          time: { created: 1_777_217_640_000 },
          model: { providerID: "openai", modelID: "gpt-5.5" },
          agent: "default",
          variant: "high",
        } as unknown as OpenCodeMessage,
        parts: [] as OpenCodePart[],
      },
    ]);

    expect(state).toEqual({
      model: "openai/gpt-5.5",
      modeId: "build",
      thinkingOptionId: "high",
    });
  });

  test("builds resume config with explicit overrides taking precedence", () => {
    const config = __openCodeInternals.buildOpenCodeResumeConfig({
      cwd: "/repo",
      persistedState: {
        model: "openai/gpt-5.5",
        modeId: "build",
        thinkingOptionId: "medium",
      },
      overrides: {
        model: "anthropic/claude-sonnet-4-6",
        modeId: "plan",
      },
    });

    expect(config).toMatchObject({
      provider: "opencode",
      cwd: "/repo",
      model: "anthropic/claude-sonnet-4-6",
      modeId: "plan",
      thinkingOptionId: "medium",
    });
  });

  test("builds persistence metadata with OpenCode model, mode, and thinking option", () => {
    expect(
      __openCodeInternals.buildOpenCodePersistenceMetadata({
        config: {
          provider: "opencode",
          cwd: "/repo",
          model: "openai/gpt-5.5",
          modeId: "build",
          thinkingOptionId: "medium",
        },
        currentMode: "review",
        closeBehavior: "detach",
      }),
    ).toEqual({
      cwd: "/repo",
      model: "openai/gpt-5.5",
      modeId: "review",
      thinkingOptionId: "medium",
      paseoCloseBehavior: "detach",
    });
  });

  test("close reconciliation aborts then archives upstream session", async () => {
    const abort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const update = vi.fn().mockResolvedValue({
      data: { id: "session-1", time: { archived: Date.now() } },
      error: undefined,
    });

    await __openCodeInternals.reconcileOpenCodeSessionClose({
      client: {
        session: {
          abort,
          update,
        },
      } as never,
      sessionId: "session-1",
      directory: "/tmp/project",
      logger: createTestLogger(),
      abortFirst: true,
    });

    expect(abort).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/tmp/project",
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/tmp/project",
      time: {
        archived: expect.any(Number),
      },
    });
  });

  test("close reconciliation still archives when abort returns an error", async () => {
    const abort = vi.fn().mockResolvedValue({
      data: undefined,
      error: { data: {}, errors: [], success: false },
    });
    const update = vi.fn().mockResolvedValue({
      data: { id: "session-1", time: { archived: Date.now() } },
      error: undefined,
    });

    await __openCodeInternals.reconcileOpenCodeSessionClose({
      client: {
        session: {
          abort,
          update,
        },
      } as never,
      sessionId: "session-1",
      directory: "/tmp/project",
      logger: createTestLogger(),
      abortFirst: true,
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("close reconciliation skips abort for idle upstream sessions", async () => {
    const abort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const update = vi.fn().mockResolvedValue({
      data: { id: "session-1", time: { archived: Date.now() } },
      error: undefined,
    });

    await __openCodeInternals.reconcileOpenCodeSessionClose({
      client: {
        session: {
          abort,
          update,
        },
      } as never,
      sessionId: "session-1",
      directory: "/tmp/project",
      logger: createTestLogger(),
      abortFirst: false,
    });

    expect(abort).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("close reconciliation can detach without archiving upstream session", async () => {
    const abort = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const update = vi.fn().mockResolvedValue({
      data: { id: "session-1", time: { archived: Date.now() } },
      error: undefined,
    });

    await __openCodeInternals.reconcileOpenCodeSessionClose({
      client: {
        session: {
          abort,
          update,
        },
      } as never,
      sessionId: "session-1",
      directory: "/tmp/project",
      logger: createTestLogger(),
      abortFirst: true,
      archive: false,
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  test("resolves detach close behavior from persistence metadata", () => {
    expect(
      __openCodeInternals.resolveOpenCodeCloseBehavior({
        provider: "opencode",
        sessionId: "session-1",
        nativeHandle: "session-1",
        metadata: { paseoCloseBehavior: "detach" },
      }),
    ).toBe("detach");

    expect(
      __openCodeInternals.resolveOpenCodeCloseBehavior({
        provider: "opencode",
        sessionId: "session-1",
        nativeHandle: "session-1",
      }),
    ).toBe("archive");
  });

  test("selects older external OpenCode sessions after excluding active managed sessions", () => {
    const sessions = [
      { id: "active-newest", directory: "/repo" },
      { id: "external-older", directory: "/repo" },
      { id: "other-cwd", directory: "/elsewhere" },
    ];

    expect(
      __openCodeInternals.selectOpenCodePersistedSessions(sessions as never, {
        directory: "/repo",
        limit: 1,
        excludeSessionIds: ["active-newest"],
      }),
    ).toEqual([{ id: "external-older", directory: "/repo" }]);
  });

  test("builds OpenCode file parts for image prompt blocks", () => {
    expect(
      __openCodeInternals.buildOpenCodePromptParts([
        { type: "text", text: "Describe this image." },
        { type: "image", mimeType: "image/png", data: "YWJjMTIz" },
      ]),
    ).toEqual([
      { type: "text", text: "Describe this image." },
      {
        type: "file",
        mime: "image/png",
        filename: "attachment-1.png",
        url: "data:image/png;base64,YWJjMTIz",
      },
    ]);
  });

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

  test("builds model definitions from configured OpenCode providers", () => {
    const result = __openCodeInternals.buildOpenCodeModelDefinitionsFromProviders({
      providers: [
        {
          id: "custom-provider",
          name: "Custom Provider",
          models: {
            "configured-model": {
              name: "Configured Model",
              family: "custom",
              limit: { context: 123_000, output: 4096 },
            },
          },
        },
      ],
      defaultModelsByProvider: { "custom-provider": "configured-model" },
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      id: "custom-provider/configured-model",
      label: "Configured Model",
      isDefault: true,
      metadata: {
        providerId: "custom-provider",
        providerName: "Custom Provider",
        modelId: "configured-model",
        contextWindowMaxTokens: 123_000,
      },
    });
    expect(result.contextWindows.get("custom-provider/configured-model")).toBe(123_000);
  });

  test("can filter provider-list models to connected providers for fallback discovery", () => {
    const result = __openCodeInternals.buildOpenCodeModelDefinitionsFromProviders({
      providers: [
        { id: "connected", models: { usable: { name: "Usable" } } },
        { id: "disconnected", models: { hidden: { name: "Hidden" } } },
      ],
      includeProviderIds: new Set(["connected"]),
    });

    expect(result.models.map((model) => model.id)).toEqual(["connected/usable"]);
  });

  test("merges configured OpenCode provider models with connected provider catalog", () => {
    const result = __openCodeInternals.mergeOpenCodeProviderCatalogs({
      configuredProviders: [
        {
          id: "anthropic",
          models: {
            "configured-sonnet": { name: "Configured Sonnet" },
          },
        },
        {
          id: "custom-provider",
          models: {
            custom: { name: "Custom" },
          },
        },
      ],
      configuredDefaults: { anthropic: "configured-sonnet" },
      availableProviders: [
        {
          id: "anthropic",
          models: {
            "catalog-opus": { name: "Catalog Opus" },
          },
        },
        {
          id: "disconnected",
          models: {
            hidden: { name: "Hidden" },
          },
        },
      ],
      availableDefaults: { anthropic: "catalog-opus" },
      connectedProviderIds: new Set(["anthropic"]),
    });

    expect(result.providers).toEqual([
      {
        id: "anthropic",
        models: {
          "catalog-opus": { name: "Catalog Opus" },
          "configured-sonnet": { name: "Configured Sonnet" },
        },
      },
      {
        id: "custom-provider",
        models: {
          custom: { name: "Custom" },
        },
      },
    ]);
    expect(result.defaultModelsByProvider).toEqual({ anthropic: "configured-sonnet" });
  });

  test("does not expose Paseo-only full-access as an OpenCode mode", () => {
    const modes = __openCodeInternals.mergeOpenCodeModes([
      { id: "review", label: "Review" },
      { id: "tests", label: "Tests" },
    ]);

    expect(modes.map((mode) => mode.id)).toEqual(["build", "plan", "review", "tests"]);
  });

  test("treats primary and all OpenCode agents as selectable modes", () => {
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "primary" })).toBe(true);
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "all" })).toBe(true);
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "subagent" })).toBe(false);
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "all", hidden: true })).toBe(
      false,
    );
  });

  test("omits OpenCode agent override when no mode is explicitly configured", () => {
    expect(__openCodeInternals.normalizeOpenCodeModeId(undefined)).toBeNull();
    expect(__openCodeInternals.normalizeOpenCodeModeId("")).toBeNull();
    expect(__openCodeInternals.resolveOpenCodeRuntimeAgentId(undefined)).toBeNull();
  });

  test("keeps explicit OpenCode mode overrides compatible with legacy defaults", () => {
    expect(__openCodeInternals.normalizeOpenCodeModeId("default")).toBe("build");
    expect(__openCodeInternals.resolveOpenCodeRuntimeAgentId("full-access")).toBe("build");
    expect(__openCodeInternals.resolveOpenCodeRuntimeAgentId("review")).toBe("review");
  });

  test("formats OpenCode config diagnostics without raw provider config values", () => {
    const summary = __openCodeInternals.formatOpenCodeConfigSummary({
      data: {
        model: "anthropic/claude-sonnet-4-6",
        small_model: "github-copilot/gpt-5.1-mini",
        default_agent: "review",
        enabled_providers: ["anthropic"],
        disabled_providers: ["openai"],
        provider: {
          anthropic: { apiKey: "secret" },
        },
        agent: {
          review: { model: "anthropic/claude-sonnet-4-6" },
        },
      },
    });

    expect(summary).toContain("model=anthropic/claude-sonnet-4-6");
    expect(summary).toContain("default_agent=review");
    expect(summary).toContain("providers=anthropic");
    expect(summary).toContain("agents=review");
    expect(summary).not.toContain("secret");
  });

  test("formats OpenCode provider and agent diagnostics as summaries", () => {
    expect(
      __openCodeInternals.formatOpenCodeConfigProvidersSummary({
        data: {
          providers: [
            { id: "anthropic", models: { sonnet: {}, opus: {} } },
            { id: "github-copilot", models: { "gpt-5.1": {} } },
          ],
          default: { anthropic: "sonnet" },
        },
      }),
    ).toBe("anthropic(2,default=sonnet), github-copilot(1)");

    expect(
      __openCodeInternals.formatOpenCodeProviderListSummary({
        data: {
          connected: ["anthropic"],
          all: [
            { id: "anthropic", models: { sonnet: {}, opus: {} } },
            { id: "openai", models: { gpt: {} } },
          ],
        },
      }),
    ).toBe("connected=anthropic; providers=2; models=3");

    expect(
      __openCodeInternals.formatOpenCodeAgentsSummary({
        data: [
          { name: "review", mode: "all", model: "anthropic/claude-sonnet-4-6" },
          { name: "title", mode: "subagent", hidden: true, native: true },
        ],
      }),
    ).toBe("review(all,model=anthropic/claude-sonnet-4-6), title(subagent,hidden,native)");
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
      } as OpenCodeEvent,
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

  test("links OpenCode child session tool activity to the parent task card", () => {
    const state = {
      sessionId: "ses_parent",
      cwd: "/repo",
      messageRoles: new Map<string, "user" | "assistant">(),
      accumulatedUsage: {},
      streamedPartKeys: new Set<string>(),
      emittedStructuredMessageIds: new Set<string>(),
      partTypes: new Map<string, string>(),
      subAgentsByCallId: new Map(),
      subAgentCallIdByChildSessionId: new Map(),
    };

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-message",
            sessionID: "ses_parent",
            role: "assistant",
          },
        },
      } as OpenCodeEvent,
      state,
    );

    const parentTaskEvents = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "task-part",
            callID: "call_task",
            sessionID: "ses_parent",
            messageID: "assistant-message",
            type: "tool",
            tool: "task",
            state: {
              status: "running",
              input: {
                subagent_type: "explore",
                description: "Explore current directory",
              },
            },
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(parentTaskEvents).toHaveLength(1);
    const parentTask = parentTaskEvents[0];
    expect(parentTask?.type).toBe("timeline");
    if (parentTask?.type !== "timeline" || parentTask.item.type !== "tool_call") {
      throw new Error("expected parent task tool call");
    }
    expect(parentTask.item.detail).toMatchObject({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore current directory",
    });

    const linkEvents = translateOpenCodeEvent(
      {
        type: "session.created",
        properties: {
          info: {
            id: "ses_child",
            parentID: "ses_parent",
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(linkEvents).toHaveLength(1);
    const linkedTask = linkEvents[0];
    expect(linkedTask?.type).toBe("timeline");
    if (linkedTask?.type !== "timeline" || linkedTask.item.type !== "tool_call") {
      throw new Error("expected linked task update");
    }
    expect(linkedTask.item.detail).toMatchObject({
      type: "sub_agent",
      childSessionId: "ses_child",
    });

    const childToolEvents = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "child-read-part",
            callID: "call_read",
            sessionID: "ses_child",
            messageID: "child-assistant-message",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { file_path: "/repo/README.md" },
              output: { content: "hello" },
            },
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(childToolEvents).toHaveLength(1);
    const childActivity = childToolEvents[0];
    expect(childActivity?.type).toBe("timeline");
    if (childActivity?.type !== "timeline" || childActivity.item.type !== "tool_call") {
      throw new Error("expected child activity task update");
    }
    expect(childActivity.item.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore current directory",
      childSessionId: "ses_child",
      log: "[read] README.md",
      actions: [{ index: 1, toolName: "read", summary: "README.md" }],
    });

    const childGlobEvents = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "child-glob-part",
            callID: "call_glob",
            sessionID: "ses_child",
            messageID: "child-assistant-message",
            type: "tool",
            tool: "glob",
            state: {
              status: "completed",
              input: { pattern: "**/*.md" },
              output: {
                durationMs: 10,
                numFiles: 2,
                filenames: ["README.md", "docs/usage.md"],
                truncated: false,
              },
            },
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(childGlobEvents).toHaveLength(1);
    const globActivity = childGlobEvents[0];
    expect(globActivity?.type).toBe("timeline");
    if (globActivity?.type !== "timeline" || globActivity.item.type !== "tool_call") {
      throw new Error("expected child glob activity task update");
    }
    expect(globActivity.item.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Explore current directory",
      childSessionId: "ses_child",
      log: "[read] README.md\n[glob] **/*.md",
      actions: [
        { index: 1, toolName: "read", summary: "README.md" },
        { index: 2, toolName: "glob", summary: "**/*.md" },
      ],
    });
  });

  test("does not guess child session link when multiple OpenCode tasks are waiting", () => {
    const state = {
      sessionId: "ses_parent",
      cwd: "/repo",
      messageRoles: new Map<string, "user" | "assistant">(),
      accumulatedUsage: {},
      streamedPartKeys: new Set<string>(),
      emittedStructuredMessageIds: new Set<string>(),
      partTypes: new Map<string, string>(),
      subAgentsByCallId: new Map(),
      subAgentCallIdByChildSessionId: new Map(),
      pendingChildToolPartsBySessionId: new Map(),
    };

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "assistant-message", sessionID: "ses_parent", role: "assistant" },
        },
      } as OpenCodeEvent,
      state,
    );

    for (const callID of ["call_task_1", "call_task_2"]) {
      translateOpenCodeEvent(
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: `${callID}-part`,
              callID,
              sessionID: "ses_parent",
              messageID: "assistant-message",
              type: "tool",
              tool: "task",
              state: {
                status: "running",
                input: {
                  subagent_type: "explore",
                  description: callID,
                },
              },
            },
          },
        } as OpenCodeEvent,
        state,
      );
    }

    const childToolBeforeLink = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "child-read-part",
            callID: "call_read",
            sessionID: "ses_child",
            messageID: "child-assistant-message",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { file_path: "/repo/README.md" },
              output: { content: "hello" },
            },
          },
        },
      } as OpenCodeEvent,
      state,
    );
    expect(childToolBeforeLink).toEqual([]);

    const ambiguousLinkEvents = translateOpenCodeEvent(
      {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_parent" } },
      } as OpenCodeEvent,
      state,
    );
    expect(ambiguousLinkEvents).toEqual([]);

    const completedTaskEvents = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "task-1-part",
            callID: "call_task_1",
            sessionID: "ses_parent",
            messageID: "assistant-message",
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: {
                subagent_type: "explore",
                description: "call_task_1",
              },
              output: "task_id: ses_child\n\n<task_result>done</task_result>",
            },
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(completedTaskEvents).toHaveLength(2);
    const flushedActivity = completedTaskEvents[1];
    expect(flushedActivity?.type).toBe("timeline");
    if (flushedActivity?.type !== "timeline" || flushedActivity.item.type !== "tool_call") {
      throw new Error("expected flushed child activity update");
    }
    expect(flushedActivity.item.callId).toBe("call_task_1");
    expect(flushedActivity.item.detail).toMatchObject({
      type: "sub_agent",
      childSessionId: "ses_child",
      actions: [{ index: 1, toolName: "read", summary: "README.md" }],
    });
  });

  test("does not buffer unrelated child tool events without a parent subagent", () => {
    const state = {
      sessionId: "ses_parent",
      cwd: "/repo",
      messageRoles: new Map<string, "user" | "assistant">(),
      accumulatedUsage: {},
      streamedPartKeys: new Set<string>(),
      emittedStructuredMessageIds: new Set<string>(),
      partTypes: new Map<string, string>(),
      subAgentsByCallId: new Map(),
      subAgentCallIdByChildSessionId: new Map(),
      pendingChildToolPartsBySessionId: new Map(),
    };

    const events = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "unrelated-read-part",
            callID: "call_read",
            sessionID: "ses_unrelated",
            messageID: "unrelated-message",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { file_path: "/repo/README.md" },
              output: { content: "hello" },
            },
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(events).toEqual([]);
    expect(state.pendingChildToolPartsBySessionId.size).toBe(0);
  });

  test("renders github issue attachments as text prompt parts", () => {
    const parts = __openCodeInternals.buildOpenCodePromptParts([
      {
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 55,
        title: "Improve startup error details",
        url: "https://github.com/getpaseo/paseo/issues/55",
        body: "Issue body",
      },
    ]);

    expect(parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("GitHub Issue #55: Improve startup error details"),
      },
    ]);
  });
});

describe("OpenCode adapter startTurn error handling", () => {
  test("emits turn_failed when client.session.promptAsync throws synchronously", async () => {
    // Async iterable that never yields and never resolves. The IIFE in
    // startTurn synchronously hits the promptAsync throw and finishes the
    // turn before this iterator is ever pulled, so the never-resolving
    // promise inside next() is fine and gets garbage-collected.
    const neverYieldingStream: AsyncIterable<OpenCodeEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
      }),
    };

    const fakeClient = {
      event: {
        subscribe: vi.fn().mockResolvedValue({ stream: neverYieldingStream }),
      },
      session: {
        promptAsync: vi.fn(() => {
          throw new Error("boom: synchronous throw");
        }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await session.startTurn("hello");

    const failed = events.find((event) => event.type === "turn_failed");
    expect(failed).toBeDefined();
    expect(failed?.type).toBe("turn_failed");
    if (failed?.type === "turn_failed") {
      expect(failed.error).toContain("boom: synchronous throw");
    }
  });
});
