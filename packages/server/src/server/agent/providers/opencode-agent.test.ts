import { beforeAll, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client";
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
    expect(planTurn.toolCalls).toHaveLength(0);

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
    expect(buildTurn.toolCalls.some((toolCall) => toolCall.status === "completed")).toBe(true);

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
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
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

  test("treats primary and all OpenCode agents as selectable modes", () => {
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "primary" })).toBe(true);
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "all" })).toBe(true);
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "subagent" })).toBe(false);
    expect(__openCodeInternals.isSelectableOpenCodeAgent({ mode: "all", hidden: true })).toBe(
      false,
    );
  });
});

describe("OpenCode adapter startTurn error handling", () => {
  test("deletes provider session on close when persistence is disabled", async () => {
    const fakeClient = {
      session: {
        abort: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockResolvedValue({ error: null }),
        delete: vi.fn().mockResolvedValue({ error: null }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
      new Map(),
      undefined,
      false,
    );

    await session.close();

    expect(fakeClient.session.delete).toHaveBeenCalledWith({
      sessionID: "ses_unit_test",
      directory: "/tmp/test",
    });
  });

  test("does not delete provider session on close by default", async () => {
    const fakeClient = {
      session: {
        abort: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockResolvedValue({ error: null }),
        delete: vi.fn().mockResolvedValue({ error: null }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    await session.close();

    expect(fakeClient.session.delete).not.toHaveBeenCalled();
  });

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

describe("OpenCode persisted sessions", () => {
  test("listPersistedAgents returns only sessions whose cwd matches the requested cwd", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-storage-"));
    const cwd = path.join(storageRoot, "repo");
    const otherCwd = path.join(storageRoot, "other");

    writeOpenCodeJson(storageRoot, "session/project-1/ses_old.json", {
      id: "ses_old",
      directory: cwd,
      title: "Old session",
      time: { created: 1000, updated: 1000 },
    });
    writeOpenCodeJson(storageRoot, "session/project-1/ses_new.json", {
      id: "ses_new",
      directory: cwd,
      title: "New session",
      time: { created: 2000, updated: 3000 },
    });
    writeOpenCodeJson(storageRoot, "session/project-2/ses_other.json", {
      id: "ses_other",
      directory: otherCwd,
      title: "Other cwd",
      time: { created: 4000, updated: 4000 },
    });
    writeOpenCodeJson(storageRoot, "message/ses_new/msg_user.json", {
      id: "msg_user",
      sessionID: "ses_new",
      role: "user",
      time: { created: 2100 },
    });
    writeOpenCodeJson(storageRoot, "part/msg_user/prt_user.json", {
      id: "prt_user",
      sessionID: "ses_new",
      messageID: "msg_user",
      type: "text",
      text: "hello world",
      time: { start: 2100 },
    });
    writeOpenCodeJson(storageRoot, "message/ses_new/msg_assistant.json", {
      id: "msg_assistant",
      sessionID: "ses_new",
      role: "assistant",
      time: { created: 2200 },
    });
    writeOpenCodeJson(storageRoot, "part/msg_assistant/prt_assistant.json", {
      id: "prt_assistant",
      sessionID: "ses_new",
      messageID: "msg_assistant",
      type: "text",
      text: "hello back",
      time: { start: 2200 },
    });

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, storageRoot);
    const descriptors = await client.listPersistedAgents({ cwd, limit: 1 });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      provider: "opencode",
      sessionId: "ses_new",
      cwd,
      title: "New session",
      persistence: {
        provider: "opencode",
        sessionId: "ses_new",
        nativeHandle: "ses_new",
      },
    });
    expect(descriptors[0]?.lastActivityAt.toISOString()).toBe("1970-01-01T00:00:03.000Z");
    expect(descriptors[0]?.timeline).toEqual([
      { type: "user_message", text: "hello world", messageId: "msg_user" },
      { type: "assistant_message", text: "hello back" },
    ]);

    rmSync(storageRoot, { recursive: true, force: true });
  });
});

function writeOpenCodeJson(storageRoot: string, relativePath: string, value: unknown): void {
  const filePath = path.join(storageRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), "utf8");
}
