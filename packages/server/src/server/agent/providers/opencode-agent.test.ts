import { afterAll, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { OpenCodeServerManager } from "./opencode/server-manager.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";
import {
  TestOpenCodeClient,
  TestOpenCodeRuntime,
} from "./opencode/test-utils/test-opencode-runtime.js";
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

const TEST_MODEL = "openrouter/~openai/gpt-mini-latest";

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
const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY);
const canRunLiveOpenCodeTurns = hasOpenCode && hasOpenRouterKey;

(canRunLiveOpenCodeTurns ? describe : describe.skip)("OpenCodeAgentClient smoke tests", () => {
  const logger = createTestLogger();
  const buildConfig = (cwd: string): AgentSessionConfig => ({
    provider: "opencode",
    cwd,
    model: TEST_MODEL,
  });

  afterAll(async () => {
    await OpenCodeServerManager.getInstance(logger).shutdown();
  });

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
    expect(models.some((model) => model.id === TEST_MODEL)).toBe(true);

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
      // contextWindowMaxTokens is upstream-provided and may be absent for some
      // OpenCode-routed providers; assert the type only when present.
      if (model.metadata?.contextWindowMaxTokens !== undefined) {
        expect(typeof model.metadata.contextWindowMaxTokens).toBe("number");
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

  test("includes api-source providers in context window lookup even when absent from connected", () => {
    // Providers with source "api" are managed by the OpenCode console/subscription and are
    // usable even when they don't appear in `connected`.
    const lookup = __openCodeInternals.buildOpenCodeModelContextWindowLookup({
      connected: [],
      all: [
        {
          id: "pi",
          source: "api",
          models: {
            "pi-model-1": { limit: { context: 200_000 } },
          },
        },
      ],
    });

    expect(lookup.get("pi/pi-model-1")).toBe(200_000);
  });

  test("excludes non-api-source providers absent from connected in context window lookup", () => {
    const lookup = __openCodeInternals.buildOpenCodeModelContextWindowLookup({
      connected: ["openai"],
      all: [
        {
          id: "openai",
          source: "env",
          models: {
            "gpt-5": { limit: { context: 400_000 } },
          },
        },
        {
          id: "anthropic",
          source: "env",
          models: {
            "claude-opus": { limit: { context: 1_000_000 } },
          },
        },
      ],
    });

    expect(lookup.get("openai/gpt-5")).toBe(400_000);
    expect(lookup.get("anthropic/claude-opus")).toBeUndefined();
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
  test("emits turn_started before live OpenCode timeline items", async () => {
    const eventsGate = createTestDeferred<void>();
    const globalEvents = [
      {
        payload: {
          type: "server.connected",
          properties: {},
        },
      },
      {
        directory: "/tmp/test",
        payload: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_assistant",
              sessionID: "ses_unit_test",
              role: "assistant",
            },
          },
        },
      },
      {
        directory: "/tmp/test",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_unit_test",
            messageID: "msg_assistant",
            partID: "prt_text",
            field: "text",
            delta: "Hello from global",
          },
        },
      },
      {
        directory: "/tmp/test",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "ses_unit_test",
            status: { type: "idle" },
          },
        },
      },
    ];
    const fakeClient = {
      global: {
        event: vi.fn().mockResolvedValue({
          stream: (async function* () {
            await eventsGate.promise;
            yield* globalEvents;
          })(),
        }),
      },
      session: {
        promptAsync: vi.fn().mockImplementation(async () => {
          eventsGate.resolve();
          return { data: {}, error: undefined };
        }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    const turn = await collectTurnEvents(streamSession(session, "hello"));

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn_started",
      "timeline",
      "turn_completed",
    ]);
    expect(turn.events.map((event) => ("turnId" in event ? event.turnId : undefined))).toEqual([
      "opencode-turn-0",
      "opencode-turn-0",
      "opencode-turn-0",
    ]);
  });

  test("unwraps OpenCode global event payloads during a turn", async () => {
    const eventsGate = createTestDeferred<void>();
    const globalEvents = [
      {
        payload: {
          type: "server.connected",
          properties: {},
        },
      },
      {
        directory: "/tmp/other",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "other-session",
            messageID: "msg_other",
            partID: "prt_other",
            field: "text",
            delta: "ignore me",
          },
        },
      },
      {
        directory: "/tmp/test",
        payload: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_assistant",
              sessionID: "ses_unit_test",
              role: "assistant",
            },
          },
        },
      },
      {
        directory: "/tmp/test",
        payload: {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_unit_test",
            messageID: "msg_assistant",
            partID: "prt_text",
            field: "text",
            delta: "Hello from global",
          },
        },
      },
      {
        directory: "/tmp/test",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "ses_unit_test",
            status: { type: "idle" },
          },
        },
      },
    ];
    const fakeClient = {
      event: {
        subscribe: vi.fn(),
      },
      global: {
        event: vi.fn().mockResolvedValue({
          stream: (async function* () {
            await eventsGate.promise;
            yield* globalEvents;
          })(),
        }),
      },
      session: {
        promptAsync: vi.fn().mockImplementation(async () => {
          eventsGate.resolve();
          return { data: {}, error: undefined };
        }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    const turn = await collectTurnEvents(streamSession(session, "hello"));

    expect(fakeClient.global.event).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      sseMaxRetryAttempts: 0,
    });
    expect(fakeClient.event.subscribe).not.toHaveBeenCalled();
    expect(turn.turnCompleted).toBe(true);
    expect(turn.turnFailed).toBe(false);
    expect(turn.assistantMessages.map((message) => message.text).join("")).toBe(
      "Hello from global",
    );
  });

  test("keeps a turn active while OpenCode is retrying", async () => {
    vi.useFakeTimers();
    const eventsGate = createTestDeferred<void>();
    const retryStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => {
        let emitted = false;
        return {
          next: async () => {
            await eventsGate.promise;
            if (!emitted) {
              emitted = true;
              return {
                done: false,
                value: {
                  payload: {
                    type: "session.status",
                    properties: {
                      sessionID: "ses_unit_test",
                      status: {
                        type: "retry",
                        attempt: 1,
                        message: "model does not exist",
                      },
                    },
                  },
                },
              };
            }
            return new Promise(() => {});
          },
        };
      },
    };
    const fakeClient = {
      global: {
        event: vi.fn().mockResolvedValue({ stream: retryStream }),
      },
      session: {
        abort: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockResolvedValue({ error: null }),
        promptAsync: vi.fn().mockImplementation(async () => {
          eventsGate.resolve();
          return { data: {}, error: undefined };
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

    try {
      await session.startTurn("hello");
      await vi.advanceTimersByTimeAsync(10_000);

      expect(events).toContainEqual({
        type: "timeline",
        provider: "opencode",
        item: {
          type: "error",
          message: "Provider retry (attempt 1): model does not exist",
        },
        turnId: "opencode-turn-0",
      });
      expect(events.some((event) => event.type === "turn_failed")).toBe(false);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

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

  test("streamHistory preserves OpenCode replay timestamps from message and part times", async () => {
    const fakeClient = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: {
                id: "msg_user",
                sessionID: "ses_unit_test",
                role: "user",
                time: { created: 1778762475873 },
              },
              parts: [
                {
                  id: "prt_user",
                  sessionID: "ses_unit_test",
                  messageID: "msg_user",
                  type: "text",
                  text: "Reply with exactly: probe ok",
                },
              ],
            },
            {
              info: {
                id: "msg_assistant",
                sessionID: "ses_unit_test",
                role: "assistant",
                time: { created: 1778762475884, completed: 1778762489358 },
              },
              parts: [
                {
                  id: "prt_reasoning",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "reasoning",
                  text: "thinking",
                  time: { start: 1778762482953, end: 1778762483610 },
                },
                {
                  id: "prt_text",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "text",
                  text: "probe ok",
                  time: { start: 1778762483612, end: 1778762489351 },
                },
              ],
            },
          ],
          error: undefined,
        }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }

    expect(history).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        timestamp: "2026-05-14T12:41:15.873Z",
        item: {
          type: "user_message",
          text: "Reply with exactly: probe ok",
          messageId: "msg_user",
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        timestamp: "2026-05-14T12:41:22.953Z",
        item: { type: "reasoning", text: "thinking" },
      },
      {
        type: "timeline",
        provider: "opencode",
        timestamp: "2026-05-14T12:41:23.612Z",
        item: { type: "assistant_message", text: "probe ok" },
      },
    ]);
  });

  test("streamHistory omits replay timestamps when OpenCode omits times", async () => {
    const fakeClient = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: {
                id: "msg_assistant",
                sessionID: "ses_unit_test",
                role: "assistant",
              },
              parts: [
                {
                  id: "prt_text",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "text",
                  text: "no clocks here",
                },
              ],
            },
          ],
          error: undefined,
        }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }

    expect(history).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "no clocks here" },
      },
    ]);
  });

  test("emits turn_failed when client.session.promptAsync throws synchronously", async () => {
    // Yield the server-connected event, then park forever. The adapter waits
    // for that first event before sending the prompt.
    const neverYieldingStream: AsyncIterable<OpenCodeEvent> = {
      [Symbol.asyncIterator]: () => {
        let emittedConnected = false;
        return {
          next: () => {
            if (!emittedConnected) {
              emittedConnected = true;
              return Promise.resolve({
                done: false,
                value: { type: "server.connected", properties: {} } as OpenCodeEvent,
              });
            }
            return new Promise(() => {});
          },
        };
      },
    };

    const fakeClient = {
      global: {
        event: vi.fn().mockResolvedValue({ stream: neverYieldingStream }),
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

  test("delays the next prompt until a slow interrupt abort settles", async () => {
    vi.useFakeTimers();
    const abortDeferred = createTestDeferred<{ data: boolean; error: undefined }>();
    const promptAsync = vi.fn().mockResolvedValue({ data: {}, error: undefined });
    const abort = vi
      .fn()
      .mockReturnValueOnce(abortDeferred.promise)
      .mockResolvedValue({ data: true, error: undefined });
    const fakeClient = {
      global: {
        event: vi.fn().mockImplementation(
          async (options: {
            signal: AbortSignal;
          }): Promise<{ stream: AsyncIterable<OpenCodeEvent> }> => ({
            stream: abortableOpenCodeStream(options.signal),
          }),
        ),
      },
      session: {
        promptAsync,
        abort,
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );

    await session.startTurn("first");
    expect(promptAsync).toHaveBeenCalledTimes(1);

    const interruptPromise = session.interrupt();
    await vi.advanceTimersByTimeAsync(2_000);
    await interruptPromise;
    expect(abort).toHaveBeenCalledTimes(1);

    const secondTurnPromise = session.startTurn("second");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    abortDeferred.resolve({ data: true, error: undefined });
    await secondTurnPromise;
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await session.interrupt();
    vi.useRealTimers();
  });
});

describe("OpenCodeAgentClient env", () => {
  test("passes launch-context env to env-specific server acquisition", async () => {
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = new TestOpenCodeClient();
    runtime.enqueueClient(openCodeClient);
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });

    try {
      const session = await client.createSession(
        {
          provider: "opencode",
          cwd,
        },
        {
          env: {
            CHUNK14_PROBE: "expected",
          },
        },
      );
      await session.close();

      expect(runtime.acquisitions[0]).toMatchObject({
        force: false,
        env: {
          CHUNK14_PROBE: "expected",
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("OpenCode persisted sessions", () => {
  test("listPersistedAgents returns only sessions whose cwd matches the requested cwd", async () => {
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = new TestOpenCodeClient();
    const cwd = "/workspace/repo";
    const otherCwd = "/workspace/other";

    openCodeClient.experimentalSessionListResponse = {
      data: [
        {
          id: "ses_old",
          directory: cwd,
          title: "Old session",
          time: { created: 1000, updated: 1000 },
        },
        {
          id: "ses_new",
          directory: cwd,
          title: "New session",
          time: { created: 2000, updated: 3000 },
        },
        {
          id: "ses_other",
          directory: otherCwd,
          title: "Other cwd",
          time: { created: 4000, updated: 4000 },
        },
      ],
    };
    openCodeClient.sessionMessagesResponse = {
      data: [
        {
          info: {
            id: "msg_user",
            sessionID: "ses_new",
            role: "user",
            time: { created: 2100 },
            agent: "build",
            model: { providerID: "opencode", modelID: "big-pickle" },
          },
          parts: [
            {
              id: "prt_user",
              sessionID: "ses_new",
              messageID: "msg_user",
              type: "text",
              text: "hello world",
              time: { start: 2100 },
            },
          ],
        },
        {
          info: {
            id: "msg_assistant",
            sessionID: "ses_new",
            role: "assistant",
            time: { created: 2200, completed: 2400 },
            structured: { fallback: false },
            agent: "build",
            providerID: "opencode",
            modelID: "big-pickle",
          },
          parts: [
            {
              id: "prt_reasoning",
              sessionID: "ses_new",
              messageID: "msg_assistant",
              type: "reasoning",
              text: "thinking clearly",
              time: { start: 2200 },
            },
            {
              id: "prt_tool",
              sessionID: "ses_new",
              messageID: "msg_assistant",
              type: "tool",
              tool: "bash",
              callID: "call_shell",
              state: {
                status: "completed",
                input: { command: "echo hello" },
                output: "hello\n",
              },
              time: { start: 2250, end: 2300 },
            },
            {
              id: "prt_assistant",
              sessionID: "ses_new",
              messageID: "msg_assistant",
              type: "text",
              text: "hello back",
              time: { start: 2350 },
            },
          ],
        },
      ],
    };
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
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
        metadata: {
          modeId: "build",
          model: "opencode/big-pickle",
        },
      },
    });
    expect(descriptors[0]?.lastActivityAt.toISOString()).toBe("1970-01-01T00:00:03.000Z");
    expect(descriptors[0]?.timeline).toEqual([
      { type: "user_message", text: "hello world", messageId: "msg_user" },
      { type: "reasoning", text: "thinking clearly" },
      expect.objectContaining({
        type: "tool_call",
        callId: "call_shell",
        status: "completed",
      }),
      { type: "assistant_message", text: "hello back" },
    ]);
    expect(runtime.clientCreations).toEqual([{ baseUrl: runtime.server.url, directory: cwd }]);
    expect(openCodeClient.calls.experimentalSessionList).toEqual([
      { archived: true, roots: true, limit: 200 },
    ]);
    expect(openCodeClient.calls.sessionMessages).toEqual([
      { sessionID: "ses_new", directory: cwd },
    ]);
  });

  test("listPersistedAgents matches Windows cwd paths with forward slashes", async () => {
    const runtime = new TestOpenCodeRuntime();
    const openCodeClient = new TestOpenCodeClient();
    const requestedCwd = "C:/Users/Administrator/GhostFactory";
    const storedCwd = "C:\\Users\\Administrator\\GhostFactory";

    openCodeClient.experimentalSessionListResponse = {
      data: [
        {
          id: "ses_windows",
          directory: storedCwd,
          title: "Windows session",
          time: { created: 2000, updated: 3000 },
        },
        {
          id: "ses_other",
          directory: "C:\\Users\\Administrator\\OtherProject",
          title: "Other cwd",
          time: { created: 4000, updated: 4000 },
        },
      ],
    };
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, { runtime });
    const descriptors = await client.listPersistedAgents({ cwd: requestedCwd, limit: 1 });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      provider: "opencode",
      sessionId: "ses_windows",
      cwd: storedCwd,
      title: "Windows session",
    });
    expect(openCodeClient.calls.experimentalSessionList).toEqual([
      { archived: true, roots: true, limit: 200 },
    ]);
  });
});

function createTestDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortableOpenCodeStream(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      let emittedConnected = false;
      return {
        next: () => {
          if (!emittedConnected) {
            emittedConnected = true;
            return Promise.resolve({
              done: false,
              value: { type: "server.connected", properties: {} } as OpenCodeEvent,
            });
          }
          return new Promise<IteratorResult<OpenCodeEvent>>((resolve) => {
            if (signal.aborted) {
              resolve({ done: true, value: undefined });
              return;
            }
            signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
              once: true,
            });
          });
        },
      };
    },
  };
}
