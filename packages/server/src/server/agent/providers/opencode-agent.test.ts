import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk/v2/client";
import {
  __openCodeInternals,
  OpenCodeAgentClient,
  type OpenCodeEventTranslationState,
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

function providerAssistantMessages(events: AgentStreamEvent[], text: string): AgentStreamEvent[] {
  return events.filter(
    (event) =>
      event.type === "provider_subagent" &&
      event.event.type === "timeline" &&
      event.event.item.type === "assistant_message" &&
      event.event.item.text === text,
  );
}

type TurnEventSignature = [type: AgentStreamEvent["type"], turnId: string | undefined];

function turnEventSignatures(events: AgentStreamEvent[]): TurnEventSignature[] {
  return events.map((event) => [event.type, "turnId" in event ? event.turnId : undefined]);
}

function userMessageEvents(params: {
  sessionId: string;
  messageId: string;
  text: string;
}): unknown[] {
  return [
    {
      type: "message.updated",
      properties: {
        info: { id: params.messageId, sessionID: params.sessionId, role: "user" },
      },
    },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part_${params.messageId}`,
          sessionID: params.sessionId,
          messageID: params.messageId,
          type: "text",
          text: params.text,
          time: { start: 1, end: 2 },
        },
      },
    },
  ];
}

function assistantMessageEvents({
  sessionId = "session-1",
  messageId = "msg_assistant",
  text = "Hello from OpenCode",
}: {
  sessionId?: string;
  messageId?: string;
  text?: string;
} = {}): unknown[] {
  return [
    {
      type: "message.updated",
      properties: {
        info: {
          id: messageId,
          sessionID: sessionId,
          role: "assistant",
        },
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: messageId,
        partID: messageId === "msg_assistant" ? "prt_text" : `part_${messageId}`,
        field: "text",
        delta: text,
      },
    },
  ];
}

function assistantTurnEvents(
  params: {
    sessionId?: string;
    messageId?: string;
    text?: string;
  } = {},
): unknown[] {
  return [
    ...assistantMessageEvents(params),
    { type: "session.idle", properties: { sessionID: params.sessionId ?? "session-1" } },
  ];
}

async function createParentSession(
  sessionId: string,
  configure?: (openCode: TestOpenCodeClient) => void,
): Promise<{
  readonly parent: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>>;
  readonly openCode: TestOpenCodeClient;
}> {
  const runtime = new TestOpenCodeHarness();
  const openCode = new TestOpenCodeClient();
  openCode.sessionCreateResponse = { data: { id: sessionId } };
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const parent = await client.createSession({
    provider: "opencode",
    cwd: "/workspace/repo",
  });
  return { parent, openCode };
}

interface PersistedAssistantCacheTokens {
  read?: number;
  write?: number;
}

interface PersistedAssistantTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: PersistedAssistantCacheTokens;
}

interface PersistedAssistantMessageParams {
  id: string;
  parentId: string;
  sessionId?: string;
  completed?: number;
  error?: unknown;
  cost?: number;
  tokens?: PersistedAssistantTokens;
  parts?: unknown[];
}

function persistedUserMessage(id: string, sessionId = "ses_eof_reconciliation"): unknown {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
    },
    parts: [],
  };
}

function persistedAssistantMessage(params: PersistedAssistantMessageParams): unknown {
  return {
    info: {
      id: params.id,
      sessionID: params.sessionId ?? "ses_eof_reconciliation",
      role: "assistant",
      parentID: params.parentId,
      time: {
        created: 1,
        ...(params.completed !== undefined ? { completed: params.completed } : {}),
      },
      ...(params.error !== undefined ? { error: params.error } : {}),
      ...(params.cost !== undefined ? { cost: params.cost } : {}),
      ...(params.tokens ? { tokens: params.tokens } : {}),
    },
    parts: params.parts ?? [],
  };
}

function terminalTurnEvents(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.filter(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled",
  );
}

function eventsWithType(
  events: AgentStreamEvent[],
  type: AgentStreamEvent["type"],
): AgentStreamEvent[] {
  return events.filter((event) => event.type === type);
}

async function* sessionIdleStream(releaseIdle: ReturnType<typeof createTestDeferred<void>>) {
  yield { type: "server.connected", properties: {} };
  await releaseIdle.promise;
  yield {
    type: "session.idle",
    properties: { sessionID: "ses_eof_reconciliation" },
  };
}

async function createControlledEofTurn(): Promise<{
  parent: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>>;
  openCode: TestOpenCodeClient;
  events: AgentStreamEvent[];
  endStream: (events?: unknown[]) => void;
  initiatingMessageId: string;
  initiatingMessage: unknown;
}> {
  const initiatingMessageId = "msg_provider_initiating";
  const streamEnd = createTestDeferred<unknown[]>();
  const { parent, openCode } = await createParentSession("ses_eof_reconciliation", (client) => {
    client.sessionPromptAsyncEvents = [];
    client.globalEventImplementation = async (options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      return {
        stream: (async function* () {
          yield { type: "server.connected", properties: {} };
          const finalEvents = await Promise.race([
            streamEnd.promise,
            waitForAbort(signal).then(() => null),
          ]);
          for (const event of finalEvents ?? []) {
            yield event;
          }
        })(),
      };
    };
  });
  const events: AgentStreamEvent[] = [];
  parent.subscribe((event) => events.push(event));
  await parent.startTurn("hello");
  return {
    parent,
    openCode,
    events,
    endStream: (finalEvents = []) =>
      streamEnd.resolve([
        {
          type: "message.updated",
          properties: {
            info: {
              id: initiatingMessageId,
              sessionID: "ses_eof_reconciliation",
              role: "user",
            },
          },
        },
        ...finalEvents,
      ]),
    initiatingMessageId,
    initiatingMessage: persistedUserMessage(initiatingMessageId),
  };
}

async function createControlledCommandEofTurn(params: {
  prompt: string;
  customCommandName?: string;
}): Promise<{
  parent: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>>;
  openCode: TestOpenCodeClient;
  events: AgentStreamEvent[];
  endStream: () => void;
  baselineMessages: unknown[];
}> {
  const streamEnd = createTestDeferred<void>();
  const baselineUser = persistedUserMessage("msg_command_baseline_user");
  const baselineAssistant = persistedAssistantMessage({
    id: "msg_command_baseline_assistant",
    parentId: "msg_command_baseline_user",
    completed: 2,
  });
  const baselineMessages = [baselineUser, baselineAssistant];
  const { parent, openCode } = await createParentSession("ses_eof_reconciliation", (client) => {
    client.sessionMessagesResponse = { data: baselineMessages };
    client.sessionCommandEvents = [];
    client.sessionSummarizeEvents = [];
    if (params.customCommandName) {
      client.commandListResponse = {
        data: [
          {
            name: params.customCommandName,
            description: "Test command",
            source: "command",
          },
        ],
      };
    }
    client.globalEventImplementation = async (options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      return {
        stream: (async function* () {
          yield { type: "server.connected", properties: {} };
          await Promise.race([streamEnd.promise, waitForAbort(signal)]);
        })(),
      };
    };
  });
  const events: AgentStreamEvent[] = [];
  parent.subscribe((event) => events.push(event));
  await parent.startTurn(params.prompt);
  return {
    parent,
    openCode,
    events,
    endStream: () => streamEnd.resolve(),
    baselineMessages,
  };
}

async function createControlledAutonomousEofTurn(): Promise<{
  parent: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>>;
  openCode: TestOpenCodeClient;
  events: AgentStreamEvent[];
  endStream: () => void;
  initiatingMessageId: string;
  initiatingMessage: unknown;
}> {
  const initiatingMessageId = "msg_autonomous_initiating";
  const releaseAutonomousTurn = createTestDeferred<void>();
  const streamEnd = createTestDeferred<void>();
  const { parent, openCode } = await createParentSession("ses_eof_reconciliation", (client) => {
    client.globalEventImplementation = async (options) => {
      const signal = (options as { signal: AbortSignal }).signal;
      return {
        stream: (async function* () {
          yield { type: "server.connected", properties: {} };
          const shouldStart = await Promise.race([
            releaseAutonomousTurn.promise.then(() => true),
            waitForAbort(signal).then(() => false),
          ]);
          if (!shouldStart) {
            return;
          }
          yield {
            type: "message.updated",
            properties: {
              info: {
                id: initiatingMessageId,
                sessionID: "ses_eof_reconciliation",
                role: "user",
              },
            },
          };
          yield {
            type: "session.status",
            properties: {
              sessionID: "ses_eof_reconciliation",
              status: { type: "busy" },
            },
          };
          await Promise.race([streamEnd.promise, waitForAbort(signal)]);
        })(),
      };
    };
  });
  const events: AgentStreamEvent[] = [];
  parent.subscribe((event) => events.push(event));
  releaseAutonomousTurn.resolve();
  await vi.waitFor(() => {
    expect(events).toContainEqual({
      type: "turn_started",
      provider: "opencode",
      turnId: "opencode-turn-0",
    });
  });
  return {
    parent,
    openCode,
    events,
    endStream: () => streamEnd.resolve(),
    initiatingMessageId,
    initiatingMessage: persistedUserMessage(initiatingMessageId),
  };
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
    const openCode = new TestOpenCodeClient();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.provider).toBe("opencode");

    await session.close();
    expect(openCode.calls.sessionAbort).toEqual([{ sessionID: "session-1", directory: cwd }]);
    expect(openCode.calls.sessionUpdate).toEqual([]);
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("archives and unarchives the durable native session through client hooks", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const archiveClient = new TestOpenCodeClient();
    const unarchiveClient = new TestOpenCodeClient();
    runtime.enqueueClient(archiveClient);
    runtime.enqueueClient(unarchiveClient);
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const handle = {
      provider: "opencode" as const,
      sessionId: "session-1",
      metadata: { cwd },
    };

    await client.archiveNativeSession(handle);
    await client.unarchiveNativeSession(handle);

    expect(archiveClient.calls.sessionUpdate).toEqual([
      {
        sessionID: "session-1",
        directory: cwd,
        time: { archived: expect.any(Number) },
      },
    ]);
    expect(unarchiveClient.calls.sessionUpdate).toEqual([
      {
        sessionID: "session-1",
        directory: cwd,
        time: { archived: null },
      },
    ]);
    expect(runtime.acquisitions.every((acquisition) => acquisition.releaseCount === 1)).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });

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
      }),
    ]);
    // No modeId configured → no agent field: OpenCode must fall back to its
    // own default agent instead of Paseo assuming any particular agent exists.
    expect(openCodeClient.calls.sessionPromptAsync[0]).not.toHaveProperty("agent");

    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }, 120_000);

  test("uses the provider-issued user message ID without supplying a Paseo message ID", async () => {
    const providerMessageId = "msg_provider_owned_user";
    const { parent, openCode } = await createParentSession(
      "ses_provider_owned_prompt",
      (client) => {
        client.sessionPromptAsyncEvents = [
          {
            type: "message.updated",
            properties: {
              info: {
                id: providerMessageId,
                sessionID: "ses_provider_owned_prompt",
                role: "user",
              },
            },
          },
          ...assistantTurnEvents({ sessionId: "ses_provider_owned_prompt" }),
        ];
      },
    );
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    try {
      await parent.startTurn("Provider owns this ID", { clientMessageId: "client_message_1" });
      await vi.waitFor(() => {
        expect(eventsWithType(events, "turn_completed")).toHaveLength(1);
      });

      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);
      expect(openCode.calls.sessionPromptAsync[0]).not.toHaveProperty("messageID");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: {
            type: "user_message",
            text: "Provider owns this ID",
            messageId: providerMessageId,
            clientMessageId: "client_message_1",
          },
        }),
      );
    } finally {
      await parent.close();
    }
  });

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

  test("available modes reflect the agents OpenCode discovers", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.appAgentsResponse = {
      data: [
        { name: "build", mode: "primary" },
        { name: "plan", mode: "primary" },
      ],
    };
    runtime.enqueueClient(openCodeClient);
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

  test("available modes are empty when OpenCode discovers no agents", async () => {
    const cwd = tmpCwd();
    const runtime = new TestOpenCodeHarness();
    // Default TestOpenCodeClient returns no agents. Discovery failure/empty
    // must not fabricate modes — OpenCode users can rename/delete any agent,
    // so a hardcoded fallback could validate a mode that doesn't exist.
    runtime.enqueueClient(new TestOpenCodeClient());
    const client = new OpenCodeAgentClient(logger, undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig(cwd));

    const modes = await session.getAvailableModes();

    expect(modes).toEqual([]);

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
              id: "msg_user",
              sessionID: "ses_unit_test",
              role: "user",
            },
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

    const turn = await collectTurnEvents(
      streamSession(session, "hello", { clientMessageId: "client-message-1" }),
    );

    expect(turn.events.map((event) => event.type)).toEqual([
      "turn_started",
      "timeline",
      "timeline",
      "turn_completed",
    ]);
    expect(turn.events[1]).toMatchObject({
      type: "timeline",
      item: { type: "user_message", clientMessageId: "client-message-1" },
    });
    expect(turn.events.map((event) => ("turnId" in event ? event.turnId : undefined))).toEqual([
      "opencode-turn-0",
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

  test.each([
    {
      label: "completed",
      message: { id: "msg_completed", completed: 4 },
      expected: { type: "turn_completed", provider: "opencode" },
    },
    {
      label: "failed",
      message: {
        id: "msg_failed",
        error: { name: "UnknownError", data: { message: "provider failed" } },
      },
      expected: {
        type: "turn_failed",
        provider: "opencode",
        error: '{"name":"UnknownError","data":{"message":"provider failed"}}',
      },
    },
    {
      label: "interrupted",
      message: {
        id: "msg_interrupted",
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
      expected: { type: "turn_canceled", provider: "opencode", reason: "interrupted" },
    },
  ])("reconciles a persisted $label turn when the event stream ends", async (testCase) => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    const assistantMessage = persistedAssistantMessage({
      parentId: initiatingMessageId,
      ...testCase.message,
    });
    openCode.sessionMessagesResponse = { data: [initiatingMessage, assistantMessage] };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([expect.objectContaining(testCase.expected)]);
      });
      expect(openCode.calls.sessionMessages).toEqual([
        { sessionID: "ses_eof_reconciliation", directory: "/workspace/repo" },
      ]);
      expect(openCode.calls.sessionStatus).toEqual([]);
    } finally {
      await parent.close();
    }
  });

  test("replays only missing persisted assistant parts in order before the EOF terminal", async () => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    const assistantMessageId = "msg_replayed_assistant";
    const duplicateTextPart = {
      id: "prt_complete_text",
      sessionID: "ses_eof_reconciliation",
      messageID: assistantMessageId,
      type: "text" as const,
      text: "Already streamed. ",
      time: { start: 2, end: 3 },
    };
    const reasoningPart = {
      id: "prt_partial_reasoning",
      sessionID: "ses_eof_reconciliation",
      messageID: assistantMessageId,
      type: "reasoning" as const,
      text: "Checking persisted state.",
      time: { start: 3, end: 4 },
    };
    const toolPart = {
      id: "prt_completed_tool",
      sessionID: "ses_eof_reconciliation",
      messageID: assistantMessageId,
      type: "tool" as const,
      tool: "bash",
      callID: "call_eof_tool",
      state: {
        status: "completed" as const,
        input: { command: "printf repaired" },
        output: "repaired",
      },
      time: { start: 4, end: 5 },
    };
    const answerPart = {
      id: "prt_partial_answer",
      sessionID: "ses_eof_reconciliation",
      messageID: assistantMessageId,
      type: "text" as const,
      text: "Result recovered.",
      time: { start: 5, end: 6 },
    };
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          id: assistantMessageId,
          parentId: initiatingMessageId,
          completed: 7,
          parts: [duplicateTextPart, reasoningPart, toolPart, answerPart],
        }),
      ],
    };

    try {
      endStream([
        {
          type: "message.updated",
          properties: {
            info: {
              id: assistantMessageId,
              sessionID: "ses_eof_reconciliation",
              role: "assistant",
              parentID: initiatingMessageId,
            },
          },
        },
        { type: "message.part.updated", properties: { part: duplicateTextPart } },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_eof_reconciliation",
            messageID: assistantMessageId,
            partID: reasoningPart.id,
            field: "reasoning",
            delta: "Checking ",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            part: {
              ...toolPart,
              state: { status: "running", input: toolPart.state.input },
              time: { start: 4 },
            },
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "ses_eof_reconciliation",
            messageID: assistantMessageId,
            partID: answerPart.id,
            field: "text",
            delta: "Result ",
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toHaveLength(1);
      });
      const assistantItems = events.flatMap((event) => {
        if (event.type !== "timeline" || event.item.type === "user_message") {
          return [];
        }
        return [event.item];
      });
      expect(assistantItems).toEqual([
        {
          type: "assistant_message",
          text: "Already streamed. ",
          messageId: assistantMessageId,
        },
        { type: "reasoning", text: "Checking " },
        expect.objectContaining({
          type: "tool_call",
          callId: "call_eof_tool",
          status: "running",
        }),
        { type: "assistant_message", text: "Result ", messageId: assistantMessageId },
        { type: "reasoning", text: "persisted state." },
        expect.objectContaining({
          type: "tool_call",
          callId: "call_eof_tool",
          status: "completed",
          detail: expect.objectContaining({ output: "repaired" }),
        }),
        { type: "assistant_message", text: "recovered.", messageId: assistantMessageId },
      ]);
      expect(
        assistantItems.filter(
          (item) => item.type === "assistant_message" && item.text === "Already streamed. ",
        ),
      ).toHaveLength(1);
      expect(terminalTurnEvents(events)).toEqual([
        expect.objectContaining({ type: "turn_completed", provider: "opencode" }),
      ]);
    } finally {
      await parent.close();
    }
  });

  test.each([
    {
      label: "summarize",
      prompt: "/compact",
      customCommandName: undefined,
      expectedCall: "summarize" as const,
    },
    {
      label: "custom command",
      prompt: "/review staged changes",
      customCommandName: "review",
      expectedCall: "command" as const,
    },
  ])("reconciles a $label turn from its pre-dispatch baseline after EOF", async (testCase) => {
    const { parent, openCode, events, endStream, baselineMessages } =
      await createControlledCommandEofTurn({
        prompt: testCase.prompt,
        customCommandName: testCase.customCommandName,
      });
    const commandUser = persistedUserMessage(`msg_${testCase.expectedCall}_user`);
    const commandAssistantStep = persistedAssistantMessage({
      id: `msg_${testCase.expectedCall}_assistant_step`,
      parentId: `msg_${testCase.expectedCall}_user`,
      completed: 3,
      cost: 0.1,
    });
    const commandAssistant = persistedAssistantMessage({
      id: `msg_${testCase.expectedCall}_assistant`,
      parentId: `msg_${testCase.expectedCall}_user`,
      completed: 4,
      cost: 0.2,
    });
    openCode.sessionMessagesResponse = {
      data: [...baselineMessages, commandUser, commandAssistantStep, commandAssistant],
    };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({ type: "turn_completed", provider: "opencode" }),
        ]);
      });
      expect(openCode.calls.sessionMessages).toEqual([
        { sessionID: "ses_eof_reconciliation", directory: "/workspace/repo" },
        { sessionID: "ses_eof_reconciliation", directory: "/workspace/repo" },
      ]);
      if (testCase.expectedCall === "summarize") {
        expect(openCode.calls.sessionSummarize).toHaveLength(1);
        expect(openCode.calls.sessionCommand).toEqual([]);
      } else {
        expect(openCode.calls.sessionCommand).toEqual([
          expect.objectContaining({ command: "review", arguments: "staged changes" }),
        ]);
        expect(openCode.calls.sessionSummarize).toEqual([]);
      }
    } finally {
      await parent.close();
    }
  });

  test.each(["interrupt", "close"] as const)(
    "cancels a pending slash-command baseline read on $cancelMethod without dispatching",
    async (cancelMethod) => {
      const baselineRequested = createTestDeferred<AbortSignal>();
      const { parent, openCode } = await createParentSession(
        "ses_pending_command_baseline",
        (client) => {
          client.commandListResponse = {
            data: [{ name: "review", description: "Test command", source: "command" }],
          };
          client.sessionMessagesImplementation = async (_parameters, options) => {
            const signal = (options as { signal?: AbortSignal }).signal;
            if (!signal) {
              throw new Error("Expected slash-command baseline read to receive an AbortSignal");
            }
            baselineRequested.resolve(signal);
            return await new Promise<never>(() => undefined);
          };
        },
      );
      const events: AgentStreamEvent[] = [];
      parent.subscribe((event) => events.push(event));
      let closed = false;

      try {
        const startTurnPromise = parent.startTurn("/review staged changes");
        const baselineSignal = await baselineRequested.promise;
        expect(baselineSignal.aborted).toBe(false);
        expect(eventsWithType(events, "turn_started")).toHaveLength(1);

        if (cancelMethod === "interrupt") {
          await Promise.all([startTurnPromise, parent.interrupt()]);
        } else {
          await Promise.all([startTurnPromise, parent.close()]);
          closed = true;
        }

        expect(baselineSignal.aborted).toBe(true);
        expect(openCode.calls.sessionMessages).toEqual([
          { sessionID: "ses_pending_command_baseline", directory: "/workspace/repo" },
        ]);
        expect(openCode.calls.sessionCommand).toEqual([]);
        expect(openCode.calls.sessionSummarize).toEqual([]);
        expect(openCode.calls.sessionPromptAsync).toEqual([]);
        if (cancelMethod === "interrupt") {
          expect(terminalTurnEvents(events)).toEqual([
            expect.objectContaining({
              type: "turn_canceled",
              provider: "opencode",
              reason: "interrupted",
            }),
          ]);
        }
      } finally {
        if (!closed) {
          await parent.close();
        }
      }
    },
  );

  test("times out a stalled slash-command baseline once and ignores its late response", async () => {
    vi.useFakeTimers();
    const baselineRequested = createTestDeferred<AbortSignal>();
    const baselineResponse = createTestDeferred<{ data: unknown[] }>();
    const { parent, openCode } = await createParentSession(
      "ses_command_baseline_timeout",
      (client) => {
        client.commandListResponse = {
          data: [{ name: "review", description: "Test command", source: "command" }],
        };
        client.sessionCommandEvents = [];
        client.sessionMessagesImplementation = async (_parameters, options) => {
          const signal = (options as { signal?: AbortSignal }).signal;
          if (!signal) {
            throw new Error("Expected slash-command baseline read to receive an AbortSignal");
          }
          baselineRequested.resolve(signal);
          return await baselineResponse.promise;
        };
      },
    );

    try {
      const startTurn = parent.startTurn("/review staged changes");
      const baselineSignal = await baselineRequested.promise;

      await vi.advanceTimersByTimeAsync(
        __openCodeInternals.OPENCODE_FOREGROUND_MESSAGES_TIMEOUT_MS,
      );
      await expect(startTurn).resolves.toEqual({ turnId: "opencode-turn-0" });

      expect(baselineSignal.aborted).toBe(true);
      expect(openCode.calls.sessionCommand).toEqual([
        expect.objectContaining({ command: "review", arguments: "staged changes" }),
      ]);
      expect(vi.getTimerCount()).toBe(0);

      baselineResponse.resolve({ data: [persistedUserMessage("msg_late_baseline")] });
      await Promise.resolve();
      await Promise.resolve();
      expect(openCode.calls.sessionCommand).toHaveLength(1);
    } finally {
      baselineResponse.resolve({ data: [] });
      await parent.close();
      vi.useRealTimers();
    }
  });

  test.each([
    { label: "user-only history with missing session status", includeAssistant: false },
    { label: "an incomplete assistant message", includeAssistant: true },
  ])("fails EOF recovery for $label", async (testCase) => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    const messages = testCase.includeAssistant
      ? [
          initiatingMessage,
          persistedAssistantMessage({
            id: "msg_incomplete",
            parentId: initiatingMessageId,
          }),
        ]
      : [initiatingMessage];
    openCode.sessionStatusResponse = { data: {} };
    openCode.sessionMessagesResponse = { data: messages };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(eventsWithType(events, "turn_failed")).toEqual([
          expect.objectContaining({
            type: "turn_failed",
            error: "OpenCode event stream ended before the turn reached a terminal state",
          }),
        ]);
      });
      expect(eventsWithType(events, "turn_completed")).toEqual([]);
      expect(openCode.calls.sessionStatus).toEqual([]);
    } finally {
      await parent.close();
    }
  });

  test("ignores an interleaved unrelated assistant error after the owned completion", async () => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          id: "msg_owned_completed",
          parentId: initiatingMessageId,
          completed: 4,
        }),
        persistedUserMessage("msg_unrelated_user"),
        persistedAssistantMessage({
          id: "msg_unrelated_failed",
          parentId: "msg_unrelated_user",
          error: { name: "UnknownError", data: { message: "unrelated failure" } },
        }),
      ],
    };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({ type: "turn_completed", provider: "opencode" }),
        ]);
      });
    } finally {
      await parent.close();
    }
  });

  test("ignores an interleaved unrelated completion after the owned assistant error", async () => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          id: "msg_owned_failed",
          parentId: initiatingMessageId,
          error: { name: "UnknownError", data: { message: "owned failure" } },
        }),
        persistedUserMessage("msg_unrelated_user"),
        persistedAssistantMessage({
          id: "msg_unrelated_completed",
          parentId: "msg_unrelated_user",
          completed: 5,
        }),
      ],
    };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({
            type: "turn_failed",
            provider: "opencode",
            error: '{"name":"UnknownError","data":{"message":"owned failure"}}',
          }),
        ]);
      });
    } finally {
      await parent.close();
    }
  });

  test("reconciles ordered multi-step assistant messages using the terminal step", async () => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          id: "msg_step_completed",
          parentId: initiatingMessageId,
          completed: 4,
          cost: 0.1,
          tokens: { input: 5, output: 2 },
        }),
        persistedAssistantMessage({
          id: "msg_terminal_failed",
          parentId: initiatingMessageId,
          error: { name: "UnknownError", data: { message: "terminal failure" } },
          cost: 0.2,
          tokens: { input: 7, output: 3 },
        }),
      ],
    };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({
            type: "turn_failed",
            error: '{"name":"UnknownError","data":{"message":"terminal failure"}}',
          }),
        ]);
      });
      expect(eventsWithType(events, "usage_updated")).toEqual([
        expect.objectContaining({
          type: "usage_updated",
          usage: expect.objectContaining({
            inputTokens: 7,
            outputTokens: 3,
            contextWindowUsedTokens: 10,
            totalCostUsd: expect.closeTo(0.3, 10),
          }),
        }),
      ]);
    } finally {
      await parent.close();
    }
  });

  test.each([
    {
      label: "failed",
      error: { name: "UnknownError", data: { message: "provider failed after usage" } },
      terminal: "turn_failed" as const,
    },
    {
      label: "canceled",
      error: { name: "MessageAbortedError", data: { message: "aborted after usage" } },
      terminal: "turn_canceled" as const,
    },
  ])("preserves persisted usage before an EOF-recovered $label turn", async (testCase) => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          id: `msg_${testCase.label}_with_usage`,
          parentId: initiatingMessageId,
          error: testCase.error,
          cost: 0.25,
          tokens: {
            input: 10,
            output: 4,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
        }),
      ],
    };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(eventsWithType(events, testCase.terminal)).toHaveLength(1);
      });
      expect(eventsWithType(events, "usage_updated")).toEqual([
        expect.objectContaining({
          type: "usage_updated",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 3,
            outputTokens: 4,
            contextWindowUsedTokens: 20,
            totalCostUsd: 0.25,
          },
        }),
      ]);
      expect(events.findIndex((event) => event.type === "usage_updated")).toBeLessThan(
        events.findIndex((event) => event.type === testCase.terminal),
      );
    } finally {
      await parent.close();
    }
  });

  test("normalizes and merges persisted assistant usage before EOF completion", async () => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          id: "msg_usage",
          parentId: initiatingMessageId,
          completed: 4,
          cost: 0.25,
          tokens: {
            input: 10,
            output: 4,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
        }),
      ],
    };

    try {
      endStream([
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "prt_streamed_usage",
              sessionID: "ses_eof_reconciliation",
              messageID: "msg_usage",
              type: "step-finish",
              cost: 0.1,
              tokens: { input: 2, output: 1, cache: { read: 1, write: 1 } },
            },
          },
        },
      ]);
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({
            type: "turn_completed",
            usage: {
              inputTokens: 10,
              cachedInputTokens: 3,
              outputTokens: 4,
              contextWindowUsedTokens: 20,
              totalCostUsd: 0.25,
            },
          }),
        ]);
      });
    } finally {
      await parent.close();
    }
  });

  test.each([
    {
      label: "completed",
      message: { id: "msg_autonomous_completed", completed: 4 },
      expected: { type: "turn_completed", provider: "opencode" },
    },
    {
      label: "failed",
      message: {
        id: "msg_autonomous_failed",
        error: { name: "UnknownError", data: { message: "autonomous failure" } },
      },
      expected: {
        type: "turn_failed",
        provider: "opencode",
        error: '{"name":"UnknownError","data":{"message":"autonomous failure"}}',
      },
    },
    {
      label: "interrupted",
      message: {
        id: "msg_autonomous_interrupted",
        error: { name: "MessageAbortedError", data: { message: "aborted" } },
      },
      expected: { type: "turn_canceled", provider: "opencode", reason: "interrupted" },
    },
  ])("reconciles an owned autonomous $label turn after EOF", async (testCase) => {
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledAutonomousEofTurn();
    openCode.sessionMessagesResponse = {
      data: [
        initiatingMessage,
        persistedAssistantMessage({
          parentId: initiatingMessageId,
          ...testCase.message,
        }),
      ],
    };

    try {
      endStream();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([expect.objectContaining(testCase.expected)]);
      });
      expect(openCode.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await parent.close();
    }
  });

  test.each([
    {
      label: "permission-first",
      trigger: {
        type: "permission.asked",
        properties: {
          id: "perm_autonomous_eof",
          sessionID: "ses_late_owned_autonomous",
          permission: "bash",
          patterns: ["npm test"],
          metadata: { command: "npm test", cwd: "/workspace/repo" },
        },
      },
      ownershipEvent: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_late_owned_user",
            sessionID: "ses_late_owned_autonomous",
            role: "user",
          },
        },
      },
    },
    {
      label: "busy-first",
      trigger: {
        type: "session.status",
        properties: {
          sessionID: "ses_late_owned_autonomous",
          status: { type: "busy" },
        },
      },
      ownershipEvent: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_late_owned_assistant",
            sessionID: "ses_late_owned_autonomous",
            role: "assistant",
            parentID: "msg_late_owned_user",
          },
        },
      },
    },
  ])("promotes a $label autonomous turn to owned before EOF", async (testCase) => {
    const releaseEvents = createTestDeferred<void>();
    const openCode = new TestOpenCodeClient();
    openCode.sessionMessagesResponse = {
      data: [
        persistedUserMessage("msg_late_owned_user", "ses_late_owned_autonomous"),
        persistedAssistantMessage({
          id: "msg_late_owned_assistant",
          parentId: "msg_late_owned_user",
          sessionId: "ses_late_owned_autonomous",
          completed: 4,
        }),
      ],
    };
    openCode.globalEventImplementation = async () => ({
      stream: (async function* () {
        yield { type: "server.connected", properties: {} };
        await releaseEvents.promise;
        yield testCase.trigger;
        yield testCase.ownershipEvent;
      })(),
    });
    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/workspace/repo" },
      openCode.asSdkClient(),
      "ses_late_owned_autonomous",
      createTestLogger(),
      new Map(),
      undefined,
      true,
      undefined,
      undefined,
      true,
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    try {
      releaseEvents.resolve();
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({ type: "turn_completed", provider: "opencode" }),
        ]);
      });
      expect(eventsWithType(events, "turn_started")).toHaveLength(1);
      expect(openCode.calls.sessionMessages).toEqual([
        { sessionID: "ses_late_owned_autonomous", directory: "/workspace/repo" },
      ]);
    } finally {
      releaseEvents.resolve();
      await session.close();
    }
  });

  test("does not duplicate a terminal event when the event stream ends after session idle", async () => {
    const releaseIdle = createTestDeferred<void>();
    const { parent, openCode } = await createParentSession("ses_eof_reconciliation", (client) => {
      client.sessionPromptAsyncEvents = [];
      client.globalEventImplementation = async () => ({
        stream: sessionIdleStream(releaseIdle),
      });
    });
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    try {
      await parent.startTurn("hello");
      releaseIdle.resolve();
      await vi.waitFor(() => {
        expect(eventsWithType(events, "turn_completed")).toHaveLength(1);
      });
      expect(openCode.calls.sessionStatus).toEqual([]);
      expect(openCode.calls.sessionMessages).toEqual([]);
    } finally {
      releaseIdle.resolve();
      await parent.close();
    }
  });

  test("emits no terminal event when close races with in-flight EOF reconciliation", async () => {
    const { parent, openCode, events, endStream } = await createControlledEofTurn();
    const messagesRequested = createTestDeferred<AbortSignal>();
    openCode.sessionMessagesImplementation = async (_parameters, options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      if (!signal) {
        throw new Error("Expected EOF reconciliation to receive an AbortSignal");
      }
      messagesRequested.resolve(signal);
      return await new Promise<never>(() => undefined);
    };

    endStream();
    const messagesSignal = await messagesRequested.promise;
    expect(messagesSignal.aborted).toBe(false);
    await parent.close();

    expect(messagesSignal.aborted).toBe(true);
    expect(terminalTurnEvents(events)).toEqual([]);
  });

  test("emits exactly one canceled event when interrupt races with EOF reconciliation", async () => {
    const { parent, openCode, events, endStream } = await createControlledEofTurn();
    const messagesRequested = createTestDeferred<AbortSignal>();
    openCode.sessionMessagesImplementation = async (_parameters, options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      if (!signal) {
        throw new Error("Expected EOF reconciliation to receive an AbortSignal");
      }
      messagesRequested.resolve(signal);
      return await new Promise<never>(() => undefined);
    };

    try {
      endStream();
      const messagesSignal = await messagesRequested.promise;
      expect(messagesSignal.aborted).toBe(false);
      await parent.interrupt();

      expect(messagesSignal.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({
            type: "turn_canceled",
            provider: "opencode",
            reason: "interrupted",
          }),
        ]);
      });
    } finally {
      await parent.close();
    }
  });

  test("times out EOF reconciliation once and ignores its late persisted response", async () => {
    vi.useFakeTimers();
    const { parent, openCode, events, endStream, initiatingMessageId, initiatingMessage } =
      await createControlledEofTurn();
    const messagesRequested = createTestDeferred<AbortSignal>();
    const messagesResponse = createTestDeferred<{ data: unknown[] }>();
    openCode.sessionMessagesImplementation = async (_parameters, options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      if (!signal) {
        throw new Error("Expected EOF reconciliation to receive an AbortSignal");
      }
      messagesRequested.resolve(signal);
      return await messagesResponse.promise;
    };

    try {
      endStream();
      const messagesSignal = await messagesRequested.promise;

      await vi.advanceTimersByTimeAsync(
        __openCodeInternals.OPENCODE_FOREGROUND_MESSAGES_TIMEOUT_MS,
      );
      await vi.waitFor(() => {
        expect(terminalTurnEvents(events)).toEqual([
          expect.objectContaining({
            type: "turn_failed",
            provider: "opencode",
            error: "OpenCode event stream ended before the turn reached a terminal state",
          }),
        ]);
      });
      expect(messagesSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      messagesResponse.resolve({
        data: [
          initiatingMessage,
          persistedAssistantMessage({
            id: "msg_late_eof_completion",
            parentId: initiatingMessageId,
            completed: 4,
            parts: [
              {
                id: "prt_late_eof_text",
                sessionID: "ses_eof_reconciliation",
                messageID: "msg_late_eof_completion",
                type: "text",
                text: "This arrived too late.",
                time: { start: 2, end: 3 },
              },
            ],
          }),
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(terminalTurnEvents(events)).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "timeline" &&
            event.item.type === "assistant_message" &&
            event.item.text === "This arrived too late.",
        ),
      ).toBe(false);
    } finally {
      messagesResponse.resolve({ data: [] });
      await parent.close();
      vi.useRealTimers();
    }
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

  test("waits for the stop abort and provider idle before starting the next prompt", async () => {
    const { parent: session, openCode } = await createParentSession("ses_unit_test");
    const retryStarted = createTestDeferred<void>();
    const settleRetry = createTestDeferred<void>();
    const oldIdleConsumed = createTestDeferred<void>();
    const replacementCompleted = createTestDeferred<void>();
    const events: AgentStreamEvent[] = [];
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      if (openCode.calls.sessionAbort.length === 1) {
        throw new Error("abort transport failed");
      }
      retryStarted.resolve();
      await settleRetry.promise;
      return { data: true };
    };
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "provider_subagent") {
        oldIdleConsumed.resolve();
      }
      if (event.type === "turn_completed") {
        replacementCompleted.resolve();
      }
    });
    try {
      await session.startTurn("first");
      const interrupt = session.interrupt();
      await retryStarted.promise;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);

      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_unit_test" },
      });
      openCode.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_child_after_old_idle",
            parentID: "ses_unit_test",
            title: "Old idle drain marker",
            directory: "/workspace/repo",
          },
        },
      });
      await oldIdleConsumed.promise;
      const replacement = session.startTurn("second");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(openCode.calls.sessionAbort).toHaveLength(2);
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);

      settleRetry.resolve();
      await interrupt;
      await replacement;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(2);

      for (const event of assistantTurnEvents({
        sessionId: "ses_unit_test",
        text: "Replacement completed safely.",
      })) {
        openCode.emitEvent(event);
      }
      await replacementCompleted.promise;

      expect(
        turnEventSignatures(events.filter((event) => event.type !== "provider_subagent")),
      ).toEqual([
        ["turn_started", "opencode-turn-0"],
        ["turn_canceled", "opencode-turn-0"],
        ["turn_started", "opencode-turn-1"],
        ["timeline", "opencode-turn-1"],
        ["turn_completed", "opencode-turn-1"],
      ]);
    } finally {
      settleRetry.resolve();
      await session.close();
    }
  });

  test("streams an autonomous wake after the canceled run reaches its terminal", async () => {
    const { parent: session, openCode } = await createParentSession("ses_wake_after_terminal");
    const settleAbort = createTestDeferred<void>();
    const events: AgentStreamEvent[] = [];
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      await settleAbort.promise;
      return { data: true };
    };
    session.subscribe((event) => events.push(event));

    try {
      await session.startTurn("first");
      const interrupt = session.interrupt();
      await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(1));

      for (const event of assistantMessageEvents({
        sessionId: "ses_wake_after_terminal",
        messageId: "msg_canceled_assistant",
        text: "Canceled residue.",
      })) {
        openCode.emitEvent(event);
      }
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_wake_after_terminal" },
      });
      openCode.emitEvent({
        type: "session.status",
        properties: {
          sessionID: "ses_wake_after_terminal",
          status: { type: "busy" },
        },
      });
      for (const event of userMessageEvents({
        sessionId: "ses_wake_after_terminal",
        messageId: "msg_wake_after_terminal",
        text: "Wake after the canceled terminal",
      })) {
        openCode.emitEvent(event);
      }
      for (const event of assistantMessageEvents({
        sessionId: "ses_wake_after_terminal",
        messageId: "msg_wake_assistant",
        text: "Wake output streams live.",
      })) {
        openCode.emitEvent(event);
      }

      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "timeline",
            turnId: "opencode-turn-1",
            item: expect.objectContaining({ text: "Wake output streams live." }),
          }),
        ),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({ text: "Canceled residue." }),
        }),
      );

      settleAbort.resolve();
      await interrupt;
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_wake_after_terminal" },
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ type: "turn_completed", turnId: "opencode-turn-1" }),
        ),
      );
      await expect(session.startTurn("after the wake")).resolves.toEqual({
        turnId: "opencode-turn-2",
      });
    } finally {
      settleAbort.resolve();
      await session.close();
    }
  });

  test("preserves an autonomous wake that arrives after provider idle but before abort settlement", async () => {
    const { parent: session, openCode } = await createParentSession("ses_deferred_autonomous");
    const settleAbort = createTestDeferred<void>();
    const wakeEventsConsumed = createTestDeferred<void>();
    const events: AgentStreamEvent[] = [];
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      await settleAbort.promise;
      return { data: true };
    };
    session.subscribe((event) => {
      events.push(event);
      if (
        event.type === "provider_subagent" &&
        event.event.type === "upsert" &&
        event.event.id === "ses_deferred_wake_drain"
      ) {
        wakeEventsConsumed.resolve();
      }
    });

    try {
      await session.startTurn("first");
      openCode.emitEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_canceled_usage",
            sessionID: "ses_deferred_autonomous",
            messageID: "msg_canceled_assistant",
            type: "step-finish",
            tokens: { input: 100, output: 20, cache: { read: 50 } },
          },
        },
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "usage_updated",
            usage: expect.objectContaining({
              inputTokens: 100,
              outputTokens: 20,
              cachedInputTokens: 50,
            }),
          }),
        ),
      );
      const interrupt = session.interrupt();
      await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(1));
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_deferred_autonomous" },
      });
      openCode.emitEvent({
        type: "message.updated",
        properties: {
          info: {
            id: "msg_plugin_wake",
            sessionID: "ses_deferred_autonomous",
            role: "user",
          },
        },
      });
      openCode.emitEvent({
        type: "session.status",
        properties: { sessionID: "ses_deferred_autonomous", status: { type: "busy" } },
      });
      openCode.emitEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_autonomous_usage",
            sessionID: "ses_deferred_autonomous",
            messageID: "msg_autonomous_assistant",
            type: "step-finish",
            tokens: { input: 7, output: 3 },
          },
        },
      });
      for (const event of assistantTurnEvents({
        sessionId: "ses_deferred_autonomous",
        text: "Autonomous wake completed.",
      })) {
        openCode.emitEvent(event);
      }
      openCode.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_deferred_wake_drain",
            parentID: "ses_deferred_autonomous",
            title: "Deferred wake drain marker",
            directory: "/workspace/repo",
          },
        },
      });
      await wakeEventsConsumed.promise;

      settleAbort.resolve();
      await interrupt;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(events).toContainEqual({
        type: "turn_started",
        provider: "opencode",
        turnId: "opencode-turn-1",
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "turn_completed",
          provider: "opencode",
          turnId: "opencode-turn-1",
          usage: expect.objectContaining({
            inputTokens: 7,
            outputTokens: 3,
            contextWindowUsedTokens: 10,
          }),
        }),
      );
      const autonomousCompletion = events.find(
        (event) => event.type === "turn_completed" && event.turnId === "opencode-turn-1",
      );
      expect(autonomousCompletion?.type).toBe("turn_completed");
      if (autonomousCompletion?.type === "turn_completed") {
        expect(autonomousCompletion.usage?.cachedInputTokens).toBeUndefined();
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          turnId: "opencode-turn-1",
          item: expect.objectContaining({
            type: "assistant_message",
            text: "Autonomous wake completed.",
          }),
        }),
      );
      await expect(session.startTurn("after autonomous wake")).resolves.toEqual({
        turnId: "opencode-turn-2",
      });
    } finally {
      settleAbort.resolve();
      await session.close();
    }
  });

  test("waits for an idle-session abort before starting a prompt", async () => {
    const { parent: session, openCode } = await createParentSession("ses_idle_abort");
    const settleAbort = createTestDeferred<void>();
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      await settleAbort.promise;
      return { data: true };
    };

    try {
      const interrupt = session.interrupt();
      const prompt = session.startTurn("next");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(openCode.calls.sessionPromptAsync).toHaveLength(0);

      settleAbort.resolve();
      await interrupt;
      await prompt;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);
    } finally {
      settleAbort.resolve();
      await session.close();
    }
  });

  test("does not acknowledge cancellation when both abort attempts fail", async () => {
    const { parent: session, openCode } = await createParentSession("ses_failed_idle_abort");
    const events: AgentStreamEvent[] = [];
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      throw new Error("abort failed");
    };
    session.subscribe((event) => events.push(event));

    try {
      await session.startTurn("still running upstream");
      await expect(session.interrupt()).rejects.toThrow("abort failed");

      await expect(session.startTurn("unsafe replacement")).rejects.toThrow("abort failed");
      expect(openCode.calls.sessionAbort).toHaveLength(2);
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);
      expect(events.map((event) => event.type)).toEqual(["turn_started"]);
    } finally {
      await session.close();
    }
  });

  test("acknowledges the canceled turn when a repeated Stop finally aborts", async () => {
    const { parent: session, openCode } = await createParentSession("ses_retried_stop");
    const events: AgentStreamEvent[] = [];
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      if (openCode.calls.sessionAbort.length <= 2) {
        throw new Error("abort failed");
      }
      return { data: true };
    };
    session.subscribe((event) => events.push(event));

    try {
      await session.startTurn("still running upstream");
      await expect(session.interrupt()).rejects.toThrow("abort failed");
      expect(events.map((event) => event.type)).toEqual(["turn_started"]);

      await session.interrupt();

      expect(openCode.calls.sessionAbort).toHaveLength(3);
      expect(events).toContainEqual({
        type: "turn_canceled",
        provider: "opencode",
        reason: "interrupted",
        turnId: "opencode-turn-0",
      });

      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_retried_stop" },
      });
      await expect(session.startTurn("replacement")).resolves.toEqual({
        turnId: "opencode-turn-1",
      });
      expect(openCode.calls.sessionPromptAsync).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  test("keeps a waiting replacement behind an abort issued while it waits", async () => {
    const { parent: session, openCode } = await createParentSession("ses_stop_during_wait");
    const settleFirstAbort = createTestDeferred<void>();
    const settleSecondAbort = createTestDeferred<void>();
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      await (openCode.calls.sessionAbort.length === 1
        ? settleFirstAbort.promise
        : settleSecondAbort.promise);
      return { data: true };
    };

    let replacement: Promise<{ turnId: string }> | undefined;
    try {
      await session.startTurn("first");
      const firstStop = session.interrupt();
      void firstStop.catch(() => undefined);
      await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(1));

      replacement = session.startTurn("replacement");
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_stop_during_wait" },
      });

      const secondStop = session.interrupt();
      void secondStop.catch(() => undefined);
      await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(2));

      settleFirstAbort.resolve();
      await firstStop;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);

      settleSecondAbort.resolve();
      await secondStop;
      await replacement;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(2);
    } finally {
      settleFirstAbort.resolve();
      settleSecondAbort.resolve();
      await replacement?.catch(() => undefined);
      await session.close();
    }
  });

  test("keeps a replacement behind an abort left in flight by an earlier stop", async () => {
    const { parent: session, openCode } = await createParentSession("ses_carried_abort");
    const settleFirstAbort = createTestDeferred<void>();
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      if (openCode.calls.sessionAbort.length === 1) {
        await settleFirstAbort.promise;
      }
      return { data: true };
    };
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    let replacement: Promise<{ turnId: string }> | undefined;
    try {
      await session.startTurn("first");
      const firstStop = session.interrupt();
      void firstStop.catch(() => undefined);
      await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(1));

      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_carried_abort" },
      });
      openCode.emitEvent({
        type: "session.status",
        properties: {
          sessionID: "ses_carried_abort",
          status: { type: "busy" },
        },
      });
      for (const event of userMessageEvents({
        sessionId: "ses_carried_abort",
        messageId: "msg_wake_between_stops",
        text: "Autonomous wake between stops",
      })) {
        openCode.emitEvent(event);
      }
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "turn_started",
          provider: "opencode",
          turnId: "opencode-turn-1",
        }),
      );

      await session.interrupt();
      expect(openCode.calls.sessionAbort).toHaveLength(2);
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_carried_abort" },
      });

      replacement = session.startTurn("replacement");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);

      settleFirstAbort.resolve();
      await firstStop;
      await replacement;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(2);
    } finally {
      settleFirstAbort.resolve();
      await replacement?.catch(() => undefined);
      await session.close();
    }
  });

  test("keeps a replacement behind an earlier Stop's abort that is still in flight", async () => {
    const { parent: session, openCode } = await createParentSession("ses_overlapping_stops");
    const settleFirstAbort = createTestDeferred<void>();
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      if (openCode.calls.sessionAbort.length === 1) {
        await settleFirstAbort.promise;
      }
      return { data: true };
    };

    let replacement: Promise<{ turnId: string }> | undefined;
    try {
      await session.startTurn("first");
      const firstStop = session.interrupt();
      void firstStop.catch(() => undefined);
      await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(1));

      await session.interrupt();
      expect(openCode.calls.sessionAbort).toHaveLength(2);
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_overlapping_stops" },
      });

      replacement = session.startTurn("replacement");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);

      settleFirstAbort.resolve();
      await firstStop;
      await replacement;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(2);
    } finally {
      settleFirstAbort.resolve();
      await replacement?.catch(() => undefined);
      await session.close();
    }
  });

  test("does not retry an owned abort after the session closes", async () => {
    const { parent: session, openCode } = await createParentSession("ses_close_pending_abort");
    const settleOwnedAbort = createTestDeferred<void>();
    openCode.sessionAbortImplementation = async () => {
      if (openCode.calls.sessionAbort.length === 1) {
        await settleOwnedAbort.promise;
        throw new Error("late abort failure");
      }
      return { data: true };
    };

    const interrupt = session.interrupt();
    await vi.waitFor(() => expect(openCode.calls.sessionAbort).toHaveLength(1));
    await session.close();
    expect(openCode.calls.sessionAbort).toHaveLength(2);

    settleOwnedAbort.resolve();
    await expect(interrupt).rejects.toThrow("late abort failure");
    expect(openCode.calls.sessionAbort).toHaveLength(2);
  });

  test("fails closed when the SDK abort throws before returning a promise", async () => {
    const openCode = new TestOpenCodeClient();
    const sdkClient = openCode.asSdkClient();
    const workingAbort = sdkClient.session.abort;
    sdkClient.session.abort = (() => {
      throw new Error("synchronous abort failure");
    }) as typeof sdkClient.session.abort;
    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/workspace/repo" },
      sdkClient,
      "ses_sync_abort_failure",
      createTestLogger(),
    );

    try {
      await expect(session.interrupt()).rejects.toThrow("synchronous abort failure");

      await expect(session.startTurn("unsafe replacement")).rejects.toThrow(
        "synchronous abort failure",
      );
      expect(openCode.calls.sessionPromptAsync).toHaveLength(0);
    } finally {
      sdkClient.session.abort = workingAbort;
      await session.close();
    }
  });

  test("fails closed when idle-session abort attempts return SDK errors", async () => {
    const { parent: session, openCode } = await createParentSession("ses_error_idle_abort");
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => ({
      error: new Error("abort response failed"),
    });

    try {
      await expect(session.interrupt()).rejects.toThrow("abort response failed");

      await expect(session.startTurn("unsafe replacement")).rejects.toThrow(
        "abort response failed",
      );
      expect(openCode.calls.sessionAbort).toHaveLength(2);
      expect(openCode.calls.sessionPromptAsync).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("does not send a prompt while the previous provider turn is still stopping", async () => {
    vi.useFakeTimers();
    const { parent: session, openCode } = await createParentSession("ses_unit_test");
    openCode.sessionPromptAsyncEvents = [];

    try {
      await session.startTurn("first");
      await session.interrupt();

      const secondTurn = expect(session.startTurn("second")).rejects.toThrow(
        "OpenCode previous turn to stop",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await secondTurn;
      expect(openCode.calls.sessionPromptAsync).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("keeps waiting for the stop terminal when the reconnect status probe fails", async () => {
    const firstStreamEnd = createTestDeferred<void>();
    const settleAbort = createTestDeferred<void>();
    const releaseTerminal = createTestDeferred<void>();
    let subscriptionCount = 0;
    const { parent: session, openCode } = await createParentSession(
      "ses_stop_status_probe_failure",
      (client) => {
        client.globalEventImplementation = async (options) => {
          subscriptionCount += 1;
          const signal = (options as { signal: AbortSignal }).signal;
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                yield { type: "server.connected", properties: {} };
                if (subscriptionCount === 1) {
                  await firstStreamEnd.promise;
                  return;
                }
                await releaseTerminal.promise;
                yield {
                  type: "session.idle",
                  properties: { sessionID: "ses_stop_status_probe_failure" },
                };
                await waitForAbort(signal);
              },
            },
          };
        };
        client.sessionStatusImplementation = async () => {
          throw new Error("provider status unavailable");
        };
      },
    );
    openCode.sessionPromptAsyncEvents = [];
    openCode.sessionAbortImplementation = async () => {
      await settleAbort.promise;
      return { data: true };
    };

    try {
      await session.startTurn("first");
      const interrupt = session.interrupt();
      const replacement = session.startTurn("second");
      firstStreamEnd.resolve();
      await vi.waitFor(() => expect(openCode.calls.sessionStatus).toHaveLength(1));

      settleAbort.resolve();
      await interrupt;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(openCode.calls.globalEvent).toHaveLength(2);
      expect(openCode.calls.sessionStatus).toHaveLength(1);

      releaseTerminal.resolve();
      await expect(replacement).resolves.toEqual({ turnId: "opencode-turn-1" });
      expect(openCode.calls.sessionPromptAsync).toHaveLength(2);
      expect(openCode.calls.globalEvent).toHaveLength(2);
    } finally {
      settleAbort.resolve();
      releaseTerminal.resolve();
      await session.close();
    }
  }, 15_000);

  test("does not reconnect the stop observer while closing", async () => {
    const firstStreamEnd = createTestDeferred<void>();
    const streamSignals: AbortSignal[] = [];
    let subscriptionCount = 0;
    const { parent: session, openCode } = await createParentSession(
      "ses_close_while_stopping",
      (client) => {
        client.globalEventImplementation = async (options) => {
          subscriptionCount += 1;
          const signal = (options as { signal: AbortSignal }).signal;
          streamSignals.push(signal);
          return {
            stream: {
              async *[Symbol.asyncIterator]() {
                yield { type: "server.connected", properties: {} };
                if (subscriptionCount === 1) {
                  await firstStreamEnd.promise;
                  return;
                }
                await waitForAbort(signal);
              },
            },
          };
        };
      },
    );
    openCode.sessionPromptAsyncEvents = [];

    try {
      await session.startTurn("first");
      await session.interrupt();
      const replacement = session.startTurn("second");
      void replacement.catch(() => undefined);
      firstStreamEnd.resolve();
      await session.close();

      await expect(replacement).rejects.toThrow("OpenCode session is closed");
      expect(openCode.calls.globalEvent).toHaveLength(1);
    } finally {
      for (const signal of streamSignals) {
        if (!signal.aborted) {
          (signal as AbortSignal & { dispatchEvent: (event: Event) => boolean }).dispatchEvent(
            new Event("abort"),
          );
        }
      }
    }
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

  test("listImportableSessions scopes upstream rows without hydrating session messages", async () => {
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
      { archived: true, roots: true, limit: 200, directory: cwd },
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
      { archived: true, roots: true, limit: 200, directory: requestedCwd },
    ]);
  });
});

describe("OpenCode provider subagent contract", () => {
  async function createAdoptedChildSession(
    configureChild?: (client: TestOpenCodeClient) => void,
  ): Promise<{
    readonly runtime: TestOpenCodeHarness;
    readonly provider: OpenCodeAgentClient;
    readonly parent: Awaited<ReturnType<OpenCodeAgentClient["createSession"]>>;
    readonly child: Awaited<ReturnType<OpenCodeAgentClient["resumeSession"]>>;
    readonly childClient: TestOpenCodeClient;
  }> {
    const runtime = new TestOpenCodeHarness();
    const parentClient = new TestOpenCodeClient();
    const childClient = new TestOpenCodeClient();
    configureChild?.(childClient);
    parentClient.sessionCreateResponse = { data: { id: "ses_parent_external" } };
    runtime.enqueueClient(parentClient);
    runtime.enqueueClient(childClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const parent = await client.createSession(
      { provider: "opencode", cwd: "/workspace/repo" },
      { env: { PASEO_AGENT_ID: "parent-agent" } },
    );

    parentClient.emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_child_external",
          parentID: "ses_parent_external",
          title: "Externally driven child",
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const child = await client.resumeSession(
      {
        provider: "opencode",
        sessionId: "ses_child_external",
        nativeHandle: "ses_child_external",
        metadata: { cwd: "/workspace/repo" },
      },
      undefined,
      { env: { PASEO_AGENT_ID: "child-agent" } },
    );
    return { runtime, provider: client, parent, child, childClient };
  }

  test("archives an adopted child on the parent's registered OpenCode server", async () => {
    const { runtime, provider, parent, child } = await createAdoptedChildSession();
    const archiveClient = new TestOpenCodeClient();
    runtime.enqueueClient(archiveClient);

    await provider.archiveNativeSession({
      provider: "opencode",
      sessionId: "ses_child_external",
      metadata: { cwd: "/workspace/repo" },
    });

    expect(archiveClient.calls.sessionUpdate).toEqual([
      {
        sessionID: "ses_child_external",
        directory: "/workspace/repo",
        time: { archived: expect.any(Number) },
      },
    ]);
    expect(runtime.acquisitions.at(-1)).toEqual({
      kind: "existing",
      url: runtime.server.url,
      releaseCount: 1,
    });
    await child.close();
    await parent.close();
  });

  test("resumes an adopted child on the parent's registered OpenCode server", async () => {
    const runtime = new TestOpenCodeHarness();
    const parentClient = new TestOpenCodeClient();
    const childClient = new TestOpenCodeClient();
    parentClient.sessionCreateResponse = { data: { id: "ses_parent_registry" } };
    runtime.enqueueClient(parentClient);
    runtime.enqueueClient(childClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const parent = await client.createSession(
      { provider: "opencode", cwd: "/workspace/repo" },
      { env: { PASEO_AGENT_ID: "parent-agent" } },
    );
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    parentClient.emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_child_registry",
          parentID: "ses_parent_registry",
          title: "Live child",
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const child = await client.resumeSession(
      {
        provider: "opencode",
        sessionId: "ses_child_registry",
        nativeHandle: "ses_child_registry",
        metadata: { cwd: "/workspace/repo" },
      },
      undefined,
      { env: { PASEO_AGENT_ID: "child-agent" } },
    );
    await child.close();
    await parent.close();

    expect(events).toContainEqual({
      type: "provider_subagent",
      provider: "opencode",
      event: {
        type: "upsert",
        id: "ses_child_registry",
        title: "Live child",
        status: "running",
      },
    });
    expect(runtime.acquisitions).toEqual([
      { kind: "dedicated", env: { PASEO_AGENT_ID: "parent-agent" }, releaseCount: 1 },
      { kind: "existing", url: runtime.server.url, releaseCount: 1 },
    ]);
    expect(runtime.clientCreations).toEqual([
      { baseUrl: runtime.server.url, directory: "/workspace/repo" },
      { baseUrl: runtime.server.url, directory: "/workspace/repo" },
    ]);
  });

  test("synthesizes an autonomous turn for adopted child timeline events", async () => {
    const { child, childClient, parent } = await createAdoptedChildSession();
    const completed = createTestDeferred<void>();
    const events: AgentStreamEvent[] = [];
    child.subscribe((event) => {
      events.push(event);
      if (event.type === "turn_completed") {
        completed.resolve();
      }
    });

    for (const event of [
      {
        type: "session.status",
        properties: { sessionID: "ses_child_external", status: { type: "busy" } },
      },
      ...assistantTurnEvents({ sessionId: "ses_child_external", text: "child says hi" }).slice(
        0,
        2,
      ),
      { type: "session.idle", properties: { sessionID: "ses_child_external" } },
    ]) {
      childClient.emitEvent(event);
    }

    await completed.promise;
    await child.close();
    await parent.close();

    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "timeline",
      "turn_completed",
    ]);
    expect(events.map((event) => ("turnId" in event ? event.turnId : undefined))).toEqual([
      "opencode-turn-0",
      "opencode-turn-0",
      "opencode-turn-0",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "assistant_message",
          text: "child says hi",
          messageId: "msg_assistant",
        },
      }),
    );
  });

  test.each(["busy", "retry"] as const)(
    "reconciles an adopted child that was already %s before attachment",
    async (runnerStatus) => {
      const { child, childClient, parent } = await createAdoptedChildSession((client) => {
        client.sessionStatusResponse = {
          data: { ses_child_external: { type: runnerStatus } },
        };
      });
      const completed = createTestDeferred<void>();
      const events: AgentStreamEvent[] = [];
      try {
        child.subscribe((event) => {
          events.push(event);
          if (event.type === "turn_completed") {
            completed.resolve();
          }
        });

        await vi.waitFor(() => {
          expect(events).toContainEqual({
            type: "turn_started",
            provider: "opencode",
            turnId: "opencode-turn-0",
          });
        });
        for (const event of assistantTurnEvents({
          sessionId: "ses_child_external",
          text: "already-running child says hi",
        })) {
          childClient.emitEvent(event);
        }

        await completed.promise;

        expect(childClient.calls.sessionStatus).toEqual([{ directory: "/workspace/repo" }]);
        expect(turnEventSignatures(events)).toEqual([
          ["turn_started", "opencode-turn-0"],
          ["timeline", "opencode-turn-0"],
          ["turn_completed", "opencode-turn-0"],
        ]);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "timeline",
            item: expect.objectContaining({ text: "already-running child says hi" }),
          }),
        );
      } finally {
        await child.close();
        await parent.close();
      }
    },
  );

  test("ignores a stale busy snapshot after the live stream reaches idle", async () => {
    const statusStarted = createTestDeferred<void>();
    const releaseStatus = createTestDeferred<void>();
    const { child, childClient, parent } = await createAdoptedChildSession((client) => {
      client.sessionStatusImplementation = async () => {
        statusStarted.resolve();
        await releaseStatus.promise;
        return { data: { ses_child_external: { type: "busy" } } };
      };
    });
    const idleConsumed = createTestDeferred<void>();
    const events: AgentStreamEvent[] = [];
    try {
      child.subscribe((event) => {
        events.push(event);
        if (event.type === "provider_subagent") {
          idleConsumed.resolve();
        }
      });

      await statusStarted.promise;
      childClient.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_child_external" },
      });
      childClient.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_child_idle_drain_marker",
            parentID: "ses_child_external",
            title: "Idle drain marker",
          },
        },
      });
      await idleConsumed.promise;

      releaseStatus.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(events.some((event) => event.type === "turn_started")).toBe(false);
    } finally {
      releaseStatus.resolve();
      await child.close();
      await parent.close();
    }
  });

  test("uses busy as the autonomous boundary without replaying earlier idle content", async () => {
    const { parent, openCode } = await createParentSession("ses_parent_plugin_wake");
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    try {
      for (const event of userMessageEvents({
        sessionId: "ses_parent_plugin_wake",
        messageId: "msg_plugin_wake",
        text: "<system-reminder>All background tasks are complete.</system-reminder>",
      })) {
        openCode.emitEvent(event);
      }
      openCode.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_plugin_wake_drain_marker",
            parentID: "ses_parent_plugin_wake",
            title: "Pre-busy drain marker",
          },
        },
      });
      await vi.waitFor(() => {
        expect(events).toContainEqual(expect.objectContaining({ type: "provider_subagent" }));
      });
      expect(events.filter((event) => event.type !== "provider_subagent")).toEqual([]);
      events.length = 0;

      openCode.emitEvent({
        type: "session.status",
        properties: { sessionID: "ses_parent_plugin_wake", status: { type: "busy" } },
      });
      for (const event of assistantTurnEvents({
        sessionId: "ses_parent_plugin_wake",
        text: "Parent consumed the background result.",
      })) {
        openCode.emitEvent(event);
      }

      await vi.waitFor(() => {
        expect(turnEventSignatures(events)).toEqual([
          ["turn_started", "opencode-turn-0"],
          ["timeline", "opencode-turn-0"],
          ["turn_completed", "opencode-turn-0"],
        ]);
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({
            type: "assistant_message",
            text: "Parent consumed the background result.",
          }),
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: expect.objectContaining({
            text: "<system-reminder>All background tasks are complete.</system-reminder>",
          }),
        }),
      );
    } finally {
      await parent.close();
    }
  });

  test("starts autonomous activity from busy without requiring an initiating message", async () => {
    const { parent, openCode } = await createParentSession("ses_parent_busy_only");
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    try {
      openCode.emitEvent({
        type: "session.status",
        properties: { sessionID: "ses_parent_busy_only", status: { type: "busy" } },
      });
      for (const event of assistantTurnEvents({
        sessionId: "ses_parent_busy_only",
        text: "Autonomous response after busy.",
      })) {
        openCode.emitEvent(event);
      }

      await vi.waitFor(() => {
        expect(turnEventSignatures(events)).toEqual([
          ["turn_started", "opencode-turn-0"],
          ["timeline", "opencode-turn-0"],
          ["turn_completed", "opencode-turn-0"],
        ]);
      });
    } finally {
      await parent.close();
    }
  });

  test("does not mistake OpenCode session metadata for an autonomous turn", async () => {
    const { parent, openCode } = await createParentSession("ses_parent_metadata");
    const events: AgentStreamEvent[] = [];
    const streamDrained = createTestDeferred<void>();
    parent.subscribe((event) => {
      events.push(event);
      if (event.type === "provider_subagent") {
        streamDrained.resolve();
      }
    });

    try {
      openCode.emitEvent({
        type: "session.created",
        properties: { info: { id: "ses_parent_metadata" } },
      });
      openCode.emitEvent({
        type: "session.idle",
        properties: { sessionID: "ses_parent_metadata" },
      });
      for (const event of assistantTurnEvents({
        sessionId: "ses_parent_metadata",
        text: "Autonomous response.",
      })) {
        openCode.emitEvent(event);
      }
      openCode.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_child_after_parent_metadata",
            parentID: "ses_parent_metadata",
            title: "Stream drain marker",
            directory: "/workspace/repo",
          },
        },
      });

      await streamDrained.promise;
      expect(
        turnEventSignatures(events.filter((event) => event.type !== "provider_subagent")),
      ).toEqual([]);
    } finally {
      await parent.close();
    }
  });

  test("keeps an autonomous turn active until OpenCode reaches its terminal event", async () => {
    const { parent, openCode } = await createParentSession("ses_parent_active_wake");
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    try {
      openCode.emitEvent(
        userMessageEvents({
          sessionId: "ses_parent_active_wake",
          messageId: "msg_autonomous_wake",
          text: "Autonomous wake",
        })[0],
      );
      openCode.emitEvent({
        type: "session.status",
        properties: { sessionID: "ses_parent_active_wake", status: { type: "busy" } },
      });
      await vi.waitFor(() => {
        expect(events).toEqual([
          { type: "turn_started", provider: "opencode", turnId: "opencode-turn-0" },
        ]);
      });

      await expect(parent.startTurn("Continue from Paseo")).rejects.toThrow(
        "A foreground turn is already active",
      );
      expect(openCode.calls.sessionAbort).toEqual([]);
      expect(openCode.calls.sessionPromptAsync).toEqual([]);
    } finally {
      await parent.close();
    }
  });

  test("does not start a new autonomous turn when post-turn user message updates arrive for an already emitted message", async () => {
    const { parent, openCode } = await createParentSession("ses_parent_post_turn");
    openCode.sessionPromptAsyncEvents = [
      ...userMessageEvents({
        sessionId: "ses_parent_post_turn",
        messageId: "msg_user_1",
        text: "Hello OpenCode",
      }),
      ...assistantTurnEvents({
        sessionId: "ses_parent_post_turn",
        text: "Response from OpenCode",
      }),
    ];
    const events: AgentStreamEvent[] = [];
    const streamDrained = createTestDeferred<void>();
    parent.subscribe((event) => {
      events.push(event);
      if (event.type === "provider_subagent") {
        streamDrained.resolve();
      }
    });

    try {
      await parent.startTurn("Hello OpenCode");

      await vi.waitFor(() => {
        expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed" }));
      });

      // Post-turn message update for the same user message ID that already completed
      openCode.emitEvent({
        type: "message.updated",
        properties: {
          info: { id: "msg_user_1", sessionID: "ses_parent_post_turn", role: "user" },
        },
      });

      openCode.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_child_drain_marker",
            parentID: "ses_parent_post_turn",
            title: "Stream drain marker",
            directory: "/workspace/repo",
          },
        },
      });

      await streamDrained.promise;

      // Verify that no new turn_started was emitted after turn_completed
      const turnStartedCount = events.filter((e) => e.type === "turn_started").length;
      expect(turnStartedCount).toBe(1);
    } finally {
      await parent.close();
    }
  });
  test("does not adopt late output from an interrupted Paseo turn", async () => {
    const { parent, openCode } = await createParentSession("ses_parent_interrupted");
    openCode.sessionPromptAsyncEvents = [];
    const events: AgentStreamEvent[] = [];
    const streamDrained = createTestDeferred<void>();
    parent.subscribe((event) => {
      events.push(event);
      if (event.type === "provider_subagent") {
        streamDrained.resolve();
      }
    });

    try {
      await parent.startTurn("Start from Paseo");
      await parent.interrupt();

      for (const event of userMessageEvents({
        sessionId: "ses_parent_interrupted",
        messageId: "msg_delayed_interrupted_user",
        text: "Delayed interrupted prompt",
      })) {
        openCode.emitEvent(event);
      }
      for (const event of assistantTurnEvents({
        sessionId: "ses_parent_interrupted",
        text: "Late interrupted response.",
      })) {
        openCode.emitEvent(event);
      }
      openCode.emitEvent({
        type: "session.created",
        properties: {
          info: {
            id: "ses_child_after_interrupted_output",
            parentID: "ses_parent_interrupted",
            title: "Stream drain marker",
            directory: "/workspace/repo",
          },
        },
      });

      await streamDrained.promise;
      expect(events.filter((event) => event.type !== "provider_subagent")).toEqual([
        { type: "turn_started", provider: "opencode", turnId: "opencode-turn-0" },
        {
          type: "turn_canceled",
          provider: "opencode",
          reason: "interrupted",
          turnId: "opencode-turn-0",
        },
      ]);
    } finally {
      await parent.close();
    }
  });

  test("synthesizes an autonomous turn for adopted child permissions", async () => {
    const { child, childClient, parent } = await createAdoptedChildSession();
    const completed = createTestDeferred<void>();
    const events: AgentStreamEvent[] = [];
    child.subscribe((event) => {
      events.push(event);
      if (event.type === "turn_completed") {
        completed.resolve();
      }
    });

    childClient.emitEvent({
      type: "session.status",
      properties: { sessionID: "ses_child_external", status: { type: "busy" } },
    });
    childClient.emitEvent({
      type: "permission.asked",
      properties: {
        id: "perm_child_external",
        sessionID: "ses_child_external",
        permission: "bash",
        patterns: ["npm test"],
        metadata: { command: "npm test", cwd: "/workspace/repo" },
      },
    });
    childClient.emitEvent({
      type: "session.idle",
      properties: { sessionID: "ses_child_external" },
    });

    await completed.promise;
    await child.close();
    await parent.close();

    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "permission_requested",
      "turn_completed",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_requested",
        request: expect.objectContaining({ id: "perm_child_external" }),
        turnId: "opencode-turn-0",
      }),
    );
  });

  test("forwards provider child permissions through the parent session", async () => {
    const runtime = new TestOpenCodeHarness();
    const parentClient = new TestOpenCodeClient();
    parentClient.sessionCreateResponse = { data: { id: "ses_parent_permission" } };
    runtime.enqueueClient(parentClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const parent = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    parentClient.emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_provider_child_permission",
          parentID: "ses_parent_permission",
          title: "Permission child",
          directory: "/workspace/child",
        },
      },
    });
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "provider_subagent",
        provider: "opencode",
        event: expect.objectContaining({
          type: "upsert",
          id: "ses_provider_child_permission",
        }),
      });
    });

    parentClient.emitEvent({
      type: "permission.asked",
      properties: {
        id: "perm_provider_child",
        sessionID: "ses_provider_child_permission",
        permission: "bash",
        patterns: ["npm test"],
        metadata: { command: "npm test", cwd: "/workspace/repo" },
      },
    });
    await vi.waitFor(() => {
      expect(parent.getPendingPermissions()).toEqual([
        expect.objectContaining({ id: "perm_provider_child" }),
      ]);
    });
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "permission_requested",
          request: expect.objectContaining({ id: "perm_provider_child" }),
        }),
      );
    });
    expect(events.some((event) => event.type === "turn_started")).toBe(false);
    expect(
      events.find(
        (event) =>
          event.type === "permission_requested" && event.request.id === "perm_provider_child",
      ),
    ).not.toHaveProperty("turnId");
    expect(
      events.filter(
        (event) =>
          event.type === "permission_requested" && event.request.id === "perm_provider_child",
      ),
    ).toHaveLength(1);

    await parent.respondToPermission("perm_provider_child", { behavior: "allow" });
    expect(parentClient.calls.permissionReply).toContainEqual(
      expect.objectContaining({
        requestID: "perm_provider_child",
        directory: "/workspace/child",
        reply: "once",
      }),
    );
    await parent.close();
  });

  test("auto-approves provider child permissions in the child directory", async () => {
    const runtime = new TestOpenCodeHarness();
    const parentClient = new TestOpenCodeClient();
    parentClient.sessionCreateResponse = { data: { id: "ses_parent_auto_permission" } };
    runtime.enqueueClient(parentClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const parent = await client.createSession({
      provider: "opencode",
      cwd: "/workspace/repo",
      featureValues: { auto_accept: true },
    });
    parent.subscribe(() => undefined);

    parentClient.emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_provider_child_auto_permission",
          parentID: "ses_parent_auto_permission",
          title: "Auto permission child",
          directory: "/workspace/auto-child",
        },
      },
    });
    await vi.waitFor(() =>
      expect(parentClient.calls.sessionChildren.length).toBeGreaterThanOrEqual(1),
    );
    parentClient.emitEvent({
      type: "permission.asked",
      properties: {
        id: "perm_provider_child_auto",
        sessionID: "ses_provider_child_auto_permission",
        permission: "bash",
        patterns: ["npm test"],
        metadata: { command: "npm test" },
      },
    });

    await vi.waitFor(() =>
      expect(parentClient.calls.permissionReply).toContainEqual(
        expect.objectContaining({
          requestID: "perm_provider_child_auto",
          directory: "/workspace/auto-child",
          reply: "once",
        }),
      ),
    );
    expect(parent.getPendingPermissions()).toEqual([]);
    await parent.close();
  });

  test("forwards provider child questions through the parent session", async () => {
    const runtime = new TestOpenCodeHarness();
    const parentClient = new TestOpenCodeClient();
    parentClient.sessionCreateResponse = { data: { id: "ses_parent_question" } };
    runtime.enqueueClient(parentClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const parent = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    parent.subscribe((event) => events.push(event));

    parentClient.emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_provider_child_question",
          parentID: "ses_parent_question",
          title: "Question child",
          directory: "/workspace/question-child",
        },
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider_subagent",
          event: expect.objectContaining({ id: "ses_provider_child_question" }),
        }),
      ),
    );

    parentClient.emitEvent({
      type: "question.asked",
      properties: {
        id: "question_provider_child",
        sessionID: "ses_provider_child_question",
        questions: [
          {
            question: "Which path?",
            header: "Path",
            options: [{ label: "A", description: "Choose A" }],
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(parent.getPendingPermissions()).toEqual([
        expect.objectContaining({
          id: "question_provider_child",
          kind: "question",
          input: expect.objectContaining({
            questions: [expect.objectContaining({ question: "Which path?" })],
          }),
        }),
      ]);
    });
    expect(
      events.filter(
        (event) =>
          event.type === "permission_requested" && event.request.id === "question_provider_child",
      ),
    ).toHaveLength(1);

    await parent.respondToPermission("question_provider_child", {
      behavior: "allow",
      updatedInput: { answers: { Path: "A" } },
    });
    expect(parentClient.calls.questionReply).toContainEqual(
      expect.objectContaining({
        requestID: "question_provider_child",
        directory: "/workspace/question-child",
        answers: [["A"]],
      }),
    );
    await parent.close();
  });

  test("emits a provider subagent for a child created while the parent has no active turn", async () => {
    const releaseChildEvent = createTestDeferred<void>();
    const childConsumed = createTestDeferred<void>();
    const fakeClient = {
      global: {
        event: vi.fn().mockResolvedValue({
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
            await releaseChildEvent.promise;
            yield {
              type: "session.created",
              properties: {
                info: {
                  id: "ses_child_background",
                  parentID: "ses_parent",
                  title: "Plugin child",
                },
              },
            };
            yield {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_child_background",
                  sessionID: "ses_child_background",
                  role: "assistant",
                },
              },
            };
            yield {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_child_background",
                  sessionID: "ses_child_background",
                  messageID: "msg_child_background",
                  type: "text",
                  text: "Background findings.",
                  time: { start: 1, end: 2 },
                },
              },
            };
            yield {
              type: "session.idle",
              properties: { sessionID: "ses_child_background" },
            };
            childConsumed.resolve();
          })(),
        }),
      },
      session: {
        abort: vi.fn().mockResolvedValue({ error: null }),
        update: vi.fn().mockResolvedValue({ error: null }),
      },
    } as never;
    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: "/tmp/test" },
      fakeClient,
      "ses_parent",
      createTestLogger(),
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    releaseChildEvent.resolve();
    await childConsumed.promise;
    await session.close();

    expect(events).toContainEqual({
      type: "provider_subagent",
      provider: "opencode",
      event: {
        type: "upsert",
        id: "ses_child_background",
        title: "Plugin child",
        status: "running",
      },
    });
    expect(events).toContainEqual({
      type: "provider_subagent",
      provider: "opencode",
      event: {
        type: "timeline",
        id: "ses_child_background",
        item: {
          type: "assistant_message",
          text: "Background findings.",
          messageId: "msg_child_background",
        },
      },
    });
    expect(events.at(-1)).toEqual({
      type: "provider_subagent",
      provider: "opencode",
      event: { type: "upsert", id: "ses_child_background", status: "completed" },
    });
  });

  test("translates plugin child sessions without a waiting sub_agent tool call", () => {
    const state = createOpenCodeTranslationState("ses_parent");

    const events = translateOpenCodeEvent(
      {
        type: "session.updated",
        properties: {
          info: {
            id: "ses_child_plugin",
            parentID: "ses_parent",
            title: "Background plugin child",
          },
        },
      } as OpenCodeEvent,
      state,
    );

    expect(events).toEqual([
      {
        type: "provider_subagent",
        provider: "opencode",
        event: {
          type: "upsert",
          id: "ses_child_plugin",
          title: "Background plugin child",
          status: "running",
        },
      },
    ]);
  });

  test("translates provider deletion of a known child session", () => {
    const state = createOpenCodeTranslationState("ses_parent");
    state.subAgentCallIdByChildSessionId?.set("ses_child_deleted", "call_task");

    const events = translateOpenCodeEvent(
      {
        type: "session.deleted",
        properties: { sessionID: "ses_child_deleted" },
      } as OpenCodeEvent,
      state,
    );

    expect(events).toEqual([
      {
        type: "provider_subagent",
        provider: "opencode",
        event: { type: "remove", id: "ses_child_deleted" },
      },
    ]);
  });

  test("hydrates existing children breadth-first and emits each detection once after subscribe", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent" } };
    openCodeClient.sessionChildrenResponses = [
      {
        data: [
          { id: "ses_child_a", parentID: "ses_parent", title: "Child A" },
          { id: "ses_child_b", parentID: "ses_parent", title: "Child B" },
        ],
      },
      { data: [{ id: "ses_grandchild_a", parentID: "ses_child_a", title: "Grandchild A" }] },
      { data: [] },
      { data: [] },
    ];
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(4));
    await session.close();

    expect(openCodeClient.calls.sessionChildren).toEqual([
      { path: { id: "ses_parent" } },
      { path: { id: "ses_child_a" } },
      { path: { id: "ses_child_b" } },
      { path: { id: "ses_grandchild_a" } },
    ]);
    expect(events).toEqual([
      {
        type: "provider_subagent",
        provider: "opencode",
        event: { type: "upsert", id: "ses_child_a", title: "Child A", status: "completed" },
      },
      {
        type: "provider_subagent",
        provider: "opencode",
        event: { type: "upsert", id: "ses_child_b", title: "Child B", status: "completed" },
      },
      {
        type: "provider_subagent",
        provider: "opencode",
        event: {
          type: "upsert",
          id: "ses_grandchild_a",
          title: "Grandchild A",
          status: "completed",
        },
      },
    ]);
  });

  test("hydrates persisted child messages into the provider subagent timeline", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_with_history" } };
    openCodeClient.sessionChildrenResponses = [
      {
        data: [
          {
            id: "ses_child_with_history",
            parentID: "ses_parent_with_history",
            title: "Historical child",
            directory: "/workspace/child",
          },
        ],
      },
      { data: [] },
    ];
    openCodeClient.sessionMessagesResponse = {
      data: [
        {
          info: {
            id: "msg_child_history",
            sessionID: "ses_child_with_history",
            role: "assistant",
            time: { created: 2, completed: 2.1 },
          },
          parts: [
            {
              id: "prt_child_history",
              sessionID: "ses_child_with_history",
              messageID: "msg_child_history",
              type: "text",
              text: "Persisted child result.",
              time: { start: 2, end: 2.1 },
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
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(2));
    expect(events).toContainEqual({
      type: "provider_subagent",
      provider: "opencode",
      event: {
        type: "upsert",
        id: "ses_child_with_history",
        title: "Historical child",
        status: "completed",
        cwd: "/workspace/child",
      },
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "provider_subagent",
        provider: "opencode",
        event: {
          type: "timeline",
          id: "ses_child_with_history",
          item: expect.objectContaining({
            type: "assistant_message",
            text: "Persisted child result.",
            messageId: "msg_child_history",
          }),
          timestamp: "1970-01-01T00:00:02.000Z",
        },
      }),
    );
    expect(openCodeClient.calls.sessionMessages).toEqual([
      { sessionID: "ses_child_with_history", directory: "/workspace/child" },
    ]);
    await session.close();
  });

  test("preserves child events that arrive while existing children hydrate", async () => {
    const hydration = createTestDeferred<{
      data: Array<{ id: string; parentID: string; title: string }>;
    }>();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_hydrating" } };
    let childListRequest = 0;
    openCodeClient.sessionChildrenImplementation = async () => {
      childListRequest += 1;
      return childListRequest === 1 ? await hydration.promise : { data: [] };
    };
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(1));

    openCodeClient.emitEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_child_hydrating",
          sessionID: "ses_child_hydrating",
          role: "assistant",
        },
      },
    });
    openCodeClient.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_child_hydrating",
          sessionID: "ses_child_hydrating",
          messageID: "msg_child_hydrating",
          type: "text",
          text: "Hydration did not lose this.",
          time: { start: 1, end: 2 },
        },
      },
    });
    hydration.resolve({
      data: [
        {
          id: "ses_child_hydrating",
          parentID: "ses_parent_hydrating",
          title: "Hydrating child",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "provider_subagent",
          provider: "opencode",
          event: expect.objectContaining({
            type: "timeline",
            id: "ses_child_hydrating",
            item: expect.objectContaining({
              type: "assistant_message",
              text: "Hydration did not lose this.",
              messageId: "msg_child_hydrating",
            }),
          }),
        }),
      ),
    );
    await session.close();
  });

  test("does not duplicate persisted child output when the matching live event was buffered", async () => {
    const hydration = createTestDeferred<{
      data: Array<{ id: string; parentID: string; title: string }>;
    }>();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_dedupe" } };
    let childListRequest = 0;
    openCodeClient.sessionChildrenImplementation = async () => {
      childListRequest += 1;
      return childListRequest === 1 ? await hydration.promise : { data: [] };
    };
    const message = {
      id: "msg_child_dedupe",
      sessionID: "ses_child_dedupe",
      role: "assistant" as const,
      time: { created: 1, completed: 2 },
    };
    const part = {
      id: "prt_child_dedupe",
      sessionID: "ses_child_dedupe",
      messageID: "msg_child_dedupe",
      type: "text" as const,
      text: "Only once.",
      time: { start: 1, end: 2 },
    };
    openCodeClient.sessionMessagesResponse = { data: [{ info: message, parts: [part] }] };
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(1));

    openCodeClient.emitEvent({ type: "message.updated", properties: { info: message } });
    openCodeClient.emitEvent({ type: "message.part.updated", properties: { part } });
    hydration.resolve({
      data: [
        {
          id: "ses_child_dedupe",
          parentID: "ses_parent_dedupe",
          title: "Dedupe child",
        },
      ],
    });

    await vi.waitFor(() => expect(providerAssistantMessages(events, "Only once.")).toHaveLength(1));
    await session.close();
  });

  test("marks a hydrated child running when OpenCode reports it busy", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_busy" } };
    openCodeClient.sessionChildrenResponses = [
      { data: [{ id: "ses_child_busy", parentID: "ses_parent_busy", title: "Busy child" }] },
      { data: [] },
    ];
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(2));

    openCodeClient.emitEvent({
      type: "session.status",
      properties: { sessionID: "ses_child_busy", status: { type: "busy" } },
    });

    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "provider_subagent",
        provider: "opencode",
        event: { type: "upsert", id: "ses_child_busy", status: "running" },
      }),
    );
    await session.close();
  });

  test("preserves a live provider child user prompt", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_child_prompt" } };
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    openCodeClient.emitEvent({
      type: "session.created",
      properties: {
        info: {
          id: "ses_child_prompt",
          parentID: "ses_parent_child_prompt",
          title: "Prompt child",
        },
      },
    });
    openCodeClient.emitEvent({
      type: "message.updated",
      properties: {
        info: { id: "msg_child_prompt", sessionID: "ses_child_prompt", role: "user" },
      },
    });
    openCodeClient.emitEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_child_prompt",
          sessionID: "ses_child_prompt",
          messageID: "msg_child_prompt",
          type: "text",
          text: "Inspect the auth flow.",
          time: { start: 1, end: 2 },
        },
      },
    });

    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "provider_subagent",
        provider: "opencode",
        event: {
          type: "timeline",
          id: "ses_child_prompt",
          item: {
            type: "user_message",
            text: "Inspect the auth flow.",
            messageId: "msg_child_prompt",
          },
          timestamp: undefined,
        },
      }),
    );
    await session.close();
  });

  test("does not rehydrate children for repeated events from an unrelated session", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_isolated" } };
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    session.subscribe(() => undefined);
    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(1));
    await Promise.resolve();

    for (const messageId of ["sibling-message-1", "sibling-message-2"]) {
      openCodeClient.emitEvent({
        type: "message.updated",
        properties: {
          info: {
            id: messageId,
            sessionID: "ses_unrelated_sibling",
            role: "assistant",
          },
        },
      });
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(openCodeClient.calls.sessionChildren).toHaveLength(1);
    await session.close();
  });

  test("closes without waiting for child hydration", async () => {
    const hydration = createTestDeferred<{ data: [] }>();
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_parent_close" } };
    openCodeClient.sessionChildrenImplementation = async () => await hydration.promise;
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/workspace/repo" });
    session.subscribe(() => undefined);
    await vi.waitFor(() => expect(openCodeClient.calls.sessionChildren).toHaveLength(1));

    await session.close();

    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
    hydration.resolve({ data: [] });
  });

  test("does not fold child tool parts into the parent sub_agent action log", () => {
    const state = createOpenCodeTranslationState("ses_parent");
    const events: AgentStreamEvent[] = [];

    events.push(
      ...translateOpenCodeEvent(
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "prt_parent_task",
              sessionID: "ses_parent",
              messageID: "msg_parent",
              type: "tool",
              tool: "task",
              callID: "call_task",
              state: {
                status: "running",
                input: { subagent_type: "explore", description: "Inspect repo" },
              },
            },
          },
        } as OpenCodeEvent,
        state,
      ),
      ...translateOpenCodeEvent(
        {
          type: "session.created",
          properties: { info: { id: "ses_child", parentID: "ses_parent" } },
        } as OpenCodeEvent,
        state,
      ),
      ...translateOpenCodeEvent(
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "prt_child_tool",
              sessionID: "ses_child",
              messageID: "msg_child",
              type: "tool",
              tool: "bash",
              callID: "call_bash",
              state: { status: "completed", input: { command: "echo child" }, output: "child\n" },
            },
          },
        } as OpenCodeEvent,
        state,
      ),
    );

    const subAgentItems = events.flatMap((event) => {
      if (event.type !== "timeline" || event.item.type !== "tool_call") {
        return [];
      }
      return event.item.detail.type === "sub_agent" ? [event.item] : [];
    });
    const latest = subAgentItems.at(-1);
    if (!latest || latest.detail.type !== "sub_agent") {
      throw new Error("expected parent sub_agent timeline item");
    }

    expect(latest.detail).toEqual({
      type: "sub_agent",
      subAgentType: "explore",
      description: "Inspect repo",
      childSessionId: "ses_child",
      log: "",
      actions: [],
    });
  });
});

function createOpenCodeTranslationState(sessionId: string): OpenCodeEventTranslationState {
  return {
    sessionId,
    cwd: "/workspace/repo",
    messageRoles: new Map(),
    accumulatedUsage: {},
    streamedPartKeys: new Set(),
    emittedStructuredMessageIds: new Set(),
    compactionSummaryMessageIds: new Set(),
    emittedCompactionPartIds: new Set(),
    partTypes: new Map(),
    subAgentsByCallId: new Map(),
    subAgentCallIdByChildSessionId: new Map(),
  };
}

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

describe("OpenCode snapshot summary false-idle regression", () => {
  test("user message.updated carrying snapshot diffs does not start a turn", async () => {
    const runtime = new TestOpenCodeHarness();
    const openCodeClient = new TestOpenCodeClient();
    openCodeClient.sessionCreateResponse = { data: { id: "ses_snapshot" } };
    runtime.enqueueClient(openCodeClient);
    const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/workspace/repo" },
      { env: { PASEO_AGENT_ID: "snapshot-agent" } },
    );
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    // Captured live shape: after the turn goes idle OpenCode writes the filesystem
    // snapshot diff onto the user message, with no time.end on the message.
    openCodeClient.emitEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_snapshot_user",
          sessionID: "ses_snapshot",
          role: "user",
          time: { created: 1000 },
          summary: {
            diffs: [{ file: "packages/server/src/thing.ts", additions: 3, deletions: 1 }],
          },
        },
      },
    });
    // Drain marker: events are processed in order, so observing this one proves
    // the snapshot update above was already handled.
    openCodeClient.emitEvent({
      type: "session.created",
      properties: {
        info: { id: "ses_snapshot_child", parentID: "ses_snapshot", title: "Drain marker" },
      },
    });
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({ type: "provider_subagent" }));
    });

    expect(events.some((event) => event.type === "turn_started")).toBe(false);
    await session.close();
  });
});
