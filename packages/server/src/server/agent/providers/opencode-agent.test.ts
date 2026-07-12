import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client";
import {
  __openCodeInternals,
  OpenCodeAgentClient,
  translateOpenCodeEvent,
} from "./opencode-agent.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";
import {
  TestOpenCodeClient,
  TestOpenCodeHarness,
} from "./opencode/test-utils/test-opencode-harness.js";
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

const TEST_MODEL = "opencode/big-pickle";

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

function assistantTurnEvents({
  sessionId = "session-1",
  text = "Hello from OpenCode",
}: {
  sessionId?: string;
  text?: string;
} = {}): unknown[] {
  return [
    {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_assistant",
          sessionID: sessionId,
          role: "assistant",
        },
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: "msg_assistant",
        partID: "prt_text",
        field: "text",
        delta: text,
      },
    },
    { type: "session.idle", properties: { sessionID: sessionId } },
  ];
}

function manualCompactEvents({
  sessionId = "session-1",
  summaryText = "## Goal\n- Preserve context while continuing the task.",
}: {
  sessionId?: string;
  summaryText?: string;
} = {}): OpenCodeEvent[] {
  return [
    {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_compact_user",
          sessionID: sessionId,
          role: "user",
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_compact",
          sessionID: sessionId,
          messageID: "msg_compact_user",
          type: "compaction",
          auto: false,
        },
      },
    },
    {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_compact_summary",
          sessionID: sessionId,
          role: "assistant",
          providerID: "test-provider",
          modelID: "gpt-5.5",
        },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_compact_summary",
          sessionID: sessionId,
          messageID: "msg_compact_summary",
          type: "text",
          text: summaryText,
          time: { start: 1, end: 2 },
        },
      },
    },
    { type: "session.compacted", properties: { sessionID: sessionId } },
    { type: "session.idle", properties: { sessionID: sessionId } },
  ];
}

describe("OpenCodeAgentClient adapter smoke tests", () => {
  const logger = createTestLogger();
  const buildConfig = (cwd: string): AgentSessionConfig => ({
    provider: "opencode",
    cwd,
    model: TEST_MODEL,
  });

  test("creates a session with valid id and provider", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    runtime.enqueueClient(new TestOpenCodeClient());
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.provider).toBe("opencode");

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("single turn completes with streaming deltas", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionPromptAsyncEvents = assistantTurnEvents();
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    const iterator = streamSession(session, "Say hello");
    const turn = await collectTurnEvents(iterator);

    expect(turn.turnCompleted).toBe(true);
    expect(turn.turnFailed).toBe(false);
    expect(turn.assistantMessages).toEqual([
      {
        type: "assistant_message",
        text: "Hello from OpenCode",
        messageId: "msg_assistant",
      },
    ]);
    expect(openCodeClient.calls.sessionPromptAsync).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        directory: cwd,
        model: { providerID: "opencode", modelID: "big-pickle" },
        agent: "build",
      }),
    ]);

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);

  test("completed and structured assistant messages preserve OpenCode message IDs", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionPromptAsyncEvents = [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_structured",
            sessionID: "session-1",
            role: "assistant",
            structured: "structured reply",
            time: { completed: 1 },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_completed",
            sessionID: "session-1",
            role: "assistant",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_completed",
            sessionID: "session-1",
            messageID: "msg_completed",
            type: "text",
            text: "completed reply",
            time: { start: 1, end: 2 },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ];
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    const turn = await collectTurnEvents(streamSession(session, "Reply twice"));

    expect(turn.assistantMessages).toEqual([
      {
        type: "assistant_message",
        text: "structured reply",
        messageId: "msg_structured",
      },
      {
        type: "assistant_message",
        text: "completed reply",
        messageId: "msg_completed",
      },
    ]);

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("manual compact hides the generated summary text", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionSummarizeEvents = manualCompactEvents();
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd,
      model: "test-provider/gpt-5.5",
    });

    const turn = await collectTurnEvents(streamSession(session, "/compact"));

    expect(turn.turnCompleted).toBe(true);
    expect(turn.assistantMessages).toEqual([]);
    expect(turn.allTimelineItems).toEqual([
      { type: "user_message", text: "/compact", messageId: "msg_compact_user" },
      { type: "compaction", status: "loading", trigger: "manual" },
      { type: "compaction", status: "completed" },
    ]);
    expect(openCodeClient.calls.sessionSummarize).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        directory: cwd,
        providerID: "test-provider",
        modelID: "gpt-5.5",
      }),
    ]);

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);

  test("fetchCatalog returns models with required fields", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.providerListResponse = {
      data: {
        connected: ["opencode"],
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            source: "api",
            models: {
              "big-pickle": {
                name: "Big Pickle",
                limit: {
                  context: 200_000,
                },
              },
            },
          },
        ],
      },
    };
    openCodeClient.appAgentsResponse = {
      data: [
        {
          name: "build",
          mode: "primary",
          hidden: false,
        },
      ],
    };
    runtime.enqueueClient(openCodeClient);
    const paseoHome = tmpCwd();
    const opencodeHome = path.join(paseoHome, "opencode-home");
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      resolveHomeDir: () => opencodeHome,
    });
    const catalog = await client.fetchCatalog({ scope: "global", force: false });

    expect(Array.isArray(catalog.models)).toBe(true);
    expect(catalog.models).toHaveLength(1);

    for (const model of catalog.models) {
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
      expect(typeof model.metadata?.contextWindowMaxTokens).toBe("number");
    }
    expect(catalog.models[0]).toMatchObject({
      id: TEST_MODEL,
      label: "Big Pickle",
      metadata: {
        providerId: "opencode",
        modelId: "big-pickle",
        contextWindowMaxTokens: 200_000,
      },
    });
    expect(openCodeClient.calls.providerList).toEqual([{ directory: opencodeHome }]);
    rmSync(paseoHome, { recursive: true, force: true });
  }, 60_000);

  test("fetchCatalog releases the acquired server when opencode-home cannot be created", async () => {
    const runtime = new TestOpenCodeHarness();
    const paseoHome = tmpCwd();
    const opencodeHome = path.join(paseoHome, "opencode-home");
    writeFileSync(opencodeHome, "not a directory");
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      resolveHomeDir: () => opencodeHome,
    });

    await expect(client.fetchCatalog({ scope: "global", force: false })).rejects.toThrow();

    expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
    expect(runtime.clientCreations).toEqual([]);
    rmSync(paseoHome, { recursive: true, force: true });
  });

  test("fetchCatalog releases the acquired server when opencode-home cannot be resolved", async () => {
    const runtime = new TestOpenCodeHarness();
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      resolveHomeDir: () => {
        throw new Error("cannot resolve opencode-home");
      },
    });

    await expect(client.fetchCatalog({ scope: "global", force: false })).rejects.toThrow(
      "cannot resolve opencode-home",
    );

    expect(runtime.acquisitions).toEqual([{ kind: "current", releaseCount: 1 }]);
    expect(runtime.clientCreations).toEqual([]);
  });

  test("limits concurrent OpenCode metadata requests across clients", async () => {
    const runtime = new TestOpenCodeHarness();
    let activeProviderListCalls = 0;
    let maxActiveProviderListCalls = 0;
    const response = {
      data: {
        connected: ["opencode"],
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            source: "api",
            models: {
              "big-pickle": {
                name: "Big Pickle",
              },
            },
          },
        ],
      },
    };

    for (let index = 0; index < 12; index += 1) {
      const openCodeClient = new TestOpenCodeClient();
      openCodeClient.providerListImplementation = async () => {
        activeProviderListCalls += 1;
        maxActiveProviderListCalls = Math.max(maxActiveProviderListCalls, activeProviderListCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeProviderListCalls -= 1;
        return response;
      };
      runtime.enqueueClient(openCodeClient);
    }

    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        client.fetchCatalog({
          scope: "workspace",
          cwd: path.join(os.tmpdir(), `opencode-cwd-${index}`),
          force: false,
        }),
      ),
    );

    expect(maxActiveProviderListCalls).toBeLessThanOrEqual(4);
  });

  test("available modes include build and plan", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    runtime.enqueueClient(new TestOpenCodeClient());
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    const modes = await session.getAvailableModes();

    expect(modes.some((mode) => mode.id === "build")).toBe(true);
    expect(modes.some((mode) => mode.id === "plan")).toBe(true);

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("custom agents defined in opencode.json appear in available modes", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.appAgentsResponse = {
      data: [
        {
          name: "paseo-test-custom",
          description: "Custom agent defined for Paseo integration test",
          mode: "primary",
        },
        { name: "compaction", mode: "subagent" },
        { name: "summary", mode: "subagent" },
        { name: "title", mode: "subagent" },
      ],
    };
    runtime.enqueueClient(openCodeClient);

    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    const modes = await session.getAvailableModes();

    expect(modes.map((mode) => mode.id)).toEqual(["paseo-test-custom"]);

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

  test("plan and build modes are sent to OpenCode as distinct runtime agents", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const planOpenCodeClient = new TestOpenCodeClient();
    planOpenCodeClient.sessionPromptAsyncEvents = assistantTurnEvents({ text: "Plan response" });
    const buildOpenCodeClient = new TestOpenCodeClient();
    buildOpenCodeClient.sessionPromptAsyncEvents = [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_assistant",
            sessionID: "session-1",
            role: "assistant",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_tool",
            sessionID: "session-1",
            messageID: "msg_assistant",
            type: "tool",
            tool: "write",
            callID: "call_write",
            state: {
              status: "completed",
              input: { filePath: "build-mode-output.txt", content: "hello" },
              output: "created build-mode-output.txt",
            },
          },
        },
      },
      ...assistantTurnEvents({ text: "Build response" }),
    ];
    runtime.enqueueClient(planOpenCodeClient);
    runtime.enqueueClient(buildOpenCodeClient);
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

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
    expect(planTurn.toolCalls).toHaveLength(0);
    expect(planOpenCodeClient.calls.sessionPromptAsync).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        directory: cwd,
        agent: "plan",
      }),
    ]);

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
    expect(buildOpenCodeClient.calls.sessionPromptAsync).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        directory: cwd,
        agent: "build",
      }),
    ]);

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

  test("carries only hex OpenCode agent colors as mode color tiers", () => {
    expect(
      __openCodeInternals.mapOpenCodeAgentToMode({
        name: "review",
        description: "Review code",
        color: "#ff6b6b",
      }),
    ).toMatchObject({
      id: "review",
      label: "Review",
      description: "Review code",
      colorTier: "#ff6b6b",
    });

    expect(
      __openCodeInternals.mapOpenCodeAgentToMode({
        name: "creative",
        color: "accent",
      }),
    ).not.toHaveProperty("colorTier");

    expect(
      __openCodeInternals.mapOpenCodeAgentToMode({
        name: "debug",
        color: "#fff",
      }),
    ).not.toHaveProperty("colorTier");
  });
});

describe("OpenCode adapter startTurn error handling", () => {
  test("dynamically adds injected MCP servers without config-backed connect", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    runtime.enqueueClient(openCodeClient);
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=test-agent",
          },
        },
      });

      await collectTurnEvents(streamSession(session, "hello"));

      expect(openCodeClient.calls.mcpAdd).toEqual([
        {
          directory: cwd,
          name: "paseo",
          config: {
            type: "remote",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=test-agent",
            enabled: true,
          },
        },
      ]);
      expect(openCodeClient.calls.mcpConnect).toEqual([]);

      await session.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fails the turn when OpenCode reports MCP add failure in data payload", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.mcpAddResponse = {
      data: {
        paseo: {
          status: "failed",
          error: "SSE error: Non-200 status code (400)",
        },
      },
    };
    runtime.enqueueClient(openCodeClient);
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

    try {
      const session = await client.createSession({
        provider: "opencode",
        cwd,
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=test-agent",
          },
        },
      });

      await expect(collectTurnEvents(streamSession(session, "hello"))).rejects.toThrow(
        /Failed to add OpenCode MCP server 'paseo': SSE error/,
      );

      await session.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

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
    let eventStreamSignal: AbortSignal | undefined;
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
            return new Promise<IteratorResult<unknown>>((resolve) => {
              if (eventStreamSignal?.aborted) {
                resolve({ done: true, value: undefined });
                return;
              }
              eventStreamSignal?.addEventListener(
                "abort",
                () => resolve({ done: true, value: undefined }),
                { once: true },
              );
            });
          },
        };
      },
    };
    const fakeClient = {
      global: {
        event: vi.fn().mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
          eventStreamSignal = signal;
          return { stream: retryStream };
        }),
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

  test("waits for the OpenCode event stream to finish after close aborts it", async () => {
    const streamAborted = createTestDeferred<void>();
    const finishStreamCleanup = createTestDeferred<void>();
    const fakeClient = {
      global: {
        event: vi.fn().mockImplementation(async ({ signal }: { signal: AbortSignal }) => ({
          stream: {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                if (!signal.aborted) {
                  await waitForAbort(signal);
                }
                streamAborted.resolve();
                await finishStreamCleanup.promise;
                return { done: true, value: undefined };
              },
            }),
          },
        })),
      },
      session: {
        abort: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockResolvedValue({ error: null }),
      },
    } as never;
    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_unit_test",
      createTestLogger(),
    );
    let closeSettled = false;

    const closePromise = session.close().then(() => {
      closeSettled = true;
      return undefined;
    });
    await streamAborted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(closeSettled).toBe(false);

    finishStreamCleanup.resolve();
    await closePromise;
  });

  test("streamHistory preserves OpenCode replay timestamps from message and part times", async () => {
    const fakeClient = {
      session: {
        get: vi.fn().mockResolvedValue({
          data: { revert: undefined },
          error: undefined,
        }),
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
        item: {
          type: "assistant_message",
          text: "probe ok",
          messageId: "msg_assistant",
        },
      },
    ]);
  });

  test("streamHistory omits replay timestamps when OpenCode omits times", async () => {
    const fakeClient = {
      session: {
        get: vi.fn().mockResolvedValue({
          data: { revert: undefined },
          error: undefined,
        }),
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
        item: {
          type: "assistant_message",
          text: "no clocks here",
          messageId: "msg_assistant",
        },
      },
    ]);
  });

  test("streamHistory maps persisted OpenCode tool parts through canonical detail branches", async () => {
    const patchText = [
      "*** Begin Patch",
      "*** Delete File: /tmp/repo/src/App.tsx",
      "*** End Patch",
    ].join("\n");

    const fakeClient = {
      session: {
        get: vi.fn().mockResolvedValue({
          data: { revert: undefined },
          error: undefined,
        }),
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
                  id: "part-grep",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "tool",
                  tool: "grep",
                  callID: "call-grep",
                  state: {
                    status: "completed",
                    input: { pattern: "sendCorrelatedSessionRequest" },
                  },
                },
                {
                  id: "part-skill",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "tool",
                  tool: "skill",
                  callID: "call-skill",
                  state: {
                    status: "completed",
                    input: { name: "diagnose" },
                    output: '<skill_content name="diagnose"># Skill: diagnose</skill_content>',
                  },
                },
                {
                  id: "part-apply-patch",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "tool",
                  tool: "apply_patch",
                  callID: "call-apply-patch",
                  state: {
                    status: "completed",
                    input: { patchText },
                    output: "Success. Updated the following files:\nD /tmp/repo/src/App.tsx",
                  },
                },
                {
                  id: "part-todowrite",
                  sessionID: "ses_unit_test",
                  messageID: "msg_assistant",
                  type: "tool",
                  tool: "todowrite",
                  callID: "call-todowrite",
                  state: {
                    status: "completed",
                    input: {
                      todos: [
                        {
                          content: "Inspect current directory and existing files",
                          status: "completed",
                          priority: "high",
                        },
                      ],
                    },
                  },
                },
              ],
            },
          ],
          error: undefined,
        }),
      },
    } as never;

    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/repo" },
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
        item: {
          type: "tool_call",
          callId: "call-grep",
          name: "grep",
          status: "completed",
          detail: {
            type: "search",
            query: "sendCorrelatedSessionRequest",
            toolName: "grep",
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "tool_call",
          callId: "call-skill",
          name: "skill",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "diagnose",
            icon: "sparkles",
            text: '<skill_content name="diagnose"># Skill: diagnose</skill_content>',
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "tool_call",
          callId: "call-apply-patch",
          name: "apply_patch",
          status: "completed",
          detail: {
            type: "edit",
            filePath: "/tmp/repo/src/App.tsx",
            unifiedDiff: [
              "diff --git a//tmp/repo/src/App.tsx b//tmp/repo/src/App.tsx",
              "--- a//tmp/repo/src/App.tsx",
              "+++ /dev/null",
            ].join("\n"),
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: {
          type: "todo",
          items: [{ text: "Inspect current directory and existing files", completed: true }],
        },
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
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    runtime.enqueueClient(openCodeClient);
    const cwd = tmpCwd();
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

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
        kind: "dedicated",
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
  test("replay hides summaries produced by manual compact", () => {
    const timeline = __openCodeInternals.buildOpenCodeSessionTimeline([
      {
        info: {
          id: "msg_compact_user",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1000 },
          agent: "build",
          model: { providerID: "test-provider", modelID: "gpt-5.5" },
        },
        parts: [
          {
            id: "prt_compact_text",
            sessionID: "ses_1",
            messageID: "msg_compact_user",
            type: "text",
            text: "/compact",
          },
          {
            id: "prt_compact",
            sessionID: "ses_1",
            messageID: "msg_compact_user",
            type: "compaction",
            auto: false,
          },
        ],
      },
      {
        info: {
          id: "msg_compact_summary",
          sessionID: "ses_1",
          role: "assistant",
          time: { created: 1001, completed: 1002 },
          providerID: "test-provider",
          modelID: "gpt-5.5",
        },
        parts: [
          {
            id: "prt_summary",
            sessionID: "ses_1",
            messageID: "msg_compact_summary",
            type: "text",
            text: "## Goal\n- Preserve context while continuing the task.",
          },
        ],
      },
      {
        info: {
          id: "msg_next_user",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1003 },
          agent: "build",
          model: { providerID: "test-provider", modelID: "gpt-5.5" },
        },
        parts: [
          {
            id: "prt_next_user",
            sessionID: "ses_1",
            messageID: "msg_next_user",
            type: "text",
            text: "continue",
          },
        ],
      },
    ]);

    expect(timeline).toEqual([
      { type: "user_message", text: "/compact", messageId: "msg_compact_user" },
      { type: "compaction", status: "completed", trigger: "manual" },
      { type: "user_message", text: "continue", messageId: "msg_next_user" },
    ]);
  });

  test("replay suppresses OpenCode compaction summary messages", () => {
    const timeline = __openCodeInternals.buildOpenCodeSessionTimeline([
      {
        info: {
          id: "msg_compaction_user",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1000 },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
        parts: [
          {
            id: "prt_compaction",
            sessionID: "ses_1",
            messageID: "msg_compaction_user",
            type: "compaction",
            auto: true,
          },
        ],
      },
      {
        info: {
          id: "msg_compaction_summary",
          sessionID: "ses_1",
          role: "assistant",
          time: { created: 1001, completed: 1002 },
          parentID: "msg_compaction_user",
          providerID: "opencode",
          modelID: "big-pickle",
          mode: "compaction",
          agent: "compaction",
          path: { cwd: "/workspace/repo", root: "/workspace/repo" },
          summary: true,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "prt_summary",
            sessionID: "ses_1",
            messageID: "msg_compaction_summary",
            type: "text",
            text: "## Goal\n- Preserve context while continuing the task.",
          },
        ],
      },
      {
        info: {
          id: "msg_user_after_compaction",
          sessionID: "ses_1",
          role: "user",
          time: { created: 1003 },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
        parts: [
          {
            id: "prt_user_after_compaction",
            sessionID: "ses_1",
            messageID: "msg_user_after_compaction",
            type: "text",
            text: "/create-pr",
          },
        ],
      },
    ]);

    expect(timeline).toEqual([
      { type: "compaction", status: "completed", trigger: "auto" },
      { type: "user_message", text: "/create-pr", messageId: "msg_user_after_compaction" },
    ]);
  });

  test("listImportableSessions returns rows without hydrating session messages", async () => {
    const runtime = new TestOpenCodeHarness();
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

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const sessions = await client.listImportableSessions({ cwd, limit: 1 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      providerHandleId: "ses_new",
      cwd,
      title: "New session",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });
    expect(sessions[0]?.lastActivityAt.toISOString()).toBe("1970-01-01T00:00:03.000Z");
    expect(runtime.clientCreations).toEqual([{ baseUrl: runtime.server.url, directory: cwd }]);
    expect(openCodeClient.calls.experimentalSessionList).toEqual([
      { archived: true, roots: true, limit: 200 },
    ]);
    expect(openCodeClient.calls.sessionMessages).toEqual([]);
  });

  test("importSession reads only the selected OpenCode session without listing", async () => {
    const runtime = new TestOpenCodeHarness();
    const metadataClient = new TestOpenCodeClient();
    const resumedClient = new TestOpenCodeClient();
    const cwd = "/workspace/repo";
    const selectedSession = {
      id: "ses_selected",
      directory: cwd,
      title: "Selected session",
      time: { created: 2000, updated: 3000 },
    };
    const messages = [
      {
        info: {
          id: "msg_user",
          sessionID: "ses_selected",
          role: "user",
          time: { created: 2100 },
          agent: "build",
          model: { providerID: "opencode", modelID: "big-pickle" },
        },
        parts: [
          {
            id: "prt_user",
            sessionID: "ses_selected",
            messageID: "msg_user",
            type: "text",
            text: "import only this session",
            time: { start: 2100 },
          },
        ],
      },
    ];
    metadataClient.sessionGetResponse = { data: selectedSession };
    metadataClient.sessionMessagesResponse = { data: messages };
    resumedClient.sessionGetResponse = { data: selectedSession };
    resumedClient.sessionMessagesResponse = { data: messages };
    runtime.enqueueClient(metadataClient);
    runtime.enqueueClient(resumedClient);

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const imported = await client.importSession(
      { providerHandleId: "ses_selected", cwd },
      {
        config: { provider: "opencode", cwd },
        storedConfig: { provider: "opencode", cwd },
      },
    );

    expect(metadataClient.calls.experimentalSessionList).toEqual([]);
    expect(metadataClient.calls.sessionGet).toEqual([
      { sessionID: "ses_selected", directory: cwd },
    ]);
    expect(metadataClient.calls.sessionMessages).toEqual([
      { sessionID: "ses_selected", directory: cwd },
    ]);
    expect(imported.config).toMatchObject({
      provider: "opencode",
      cwd,
      title: "Selected session",
      modeId: "build",
      model: "opencode/big-pickle",
    });
    expect(imported.persistence).toMatchObject({
      provider: "opencode",
      sessionId: "ses_selected",
      nativeHandle: "ses_selected",
    });
    expect(imported.timeline.map((entry) => entry.item)).toEqual([
      { type: "user_message", text: "import only this session", messageId: "msg_user" },
    ]);
    expect(resumedClient.calls.sessionMessages).toEqual([
      { sessionID: "ses_selected", directory: cwd },
    ]);
  });

  test("listImportableSessions matches Windows cwd paths with forward slashes", async () => {
    const runtime = new TestOpenCodeHarness();
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

    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const sessions = await client.listImportableSessions({ cwd: requestedCwd, limit: 1 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      providerHandleId: "ses_windows",
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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
