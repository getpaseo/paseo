import type { EventSubscribeOutput } from "@opencode-ai/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type {
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./opencode-v2-agent.js";
import {
  TestOpenCodeV2Client,
  TestOpenCodeV2Harness,
} from "./opencode-v2/test-utils/test-opencode-v2-harness.js";
import { streamSession } from "./test-utils/session-stream-adapter.js";

type AssistantMessageTimelineItem = Extract<AgentTimelineItem, { type: "assistant_message" }>;

const TEST_MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";

function buildConfig(cwd: string): AgentSessionConfig {
  return {
    provider: "opencode-v2",
    cwd,
    model: TEST_MODEL,
  };
}

function v2Event(
  input: Omit<EventSubscribeOutput, "id" | "created" | "type"> & {
    type: EventSubscribeOutput["type"];
  },
): EventSubscribeOutput {
  return {
    id: "event-1",
    created: 1,
    ...input,
  } as EventSubscribeOutput;
}

function userMessageEvent(sessionId: string, inboxId: string, text: string): EventSubscribeOutput {
  return v2Event({
    type: "session.inbox.enqueued",
    data: {
      sessionID: sessionId,
      inboxID: inboxId,
      item: { type: "user", delivery: "default", payload: { text } },
    },
  });
}

function textDeltaEvent(
  sessionId: string,
  assistantMessageId: string,
  ordinal: number,
  delta: string,
): EventSubscribeOutput {
  return v2Event({
    type: "session.text.delta",
    data: {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      ordinal,
      delta,
    },
  });
}

function reasoningDeltaEvent(
  sessionId: string,
  assistantMessageId: string,
  ordinal: number,
  delta: string,
): EventSubscribeOutput {
  return v2Event({
    type: "session.reasoning.delta",
    data: {
      sessionID: sessionId,
      assistantMessageID: assistantMessageId,
      ordinal,
      delta,
    },
  });
}

function executionSucceededEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.execution.succeeded",
    data: { sessionID: sessionId },
  });
}

function executionFailedEvent(sessionId: string, message: string): EventSubscribeOutput {
  return v2Event({
    type: "session.execution.failed",
    data: {
      sessionID: sessionId,
      error: { type: "provider.no-route", message },
    },
  });
}

function executionInterruptedEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.execution.interrupted",
    data: { sessionID: sessionId, reason: "user" },
  });
}

function usageUpdatedEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.usage.updated",
    data: {
      sessionID: sessionId,
      cost: 0.012,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
    },
  });
}

function permissionAskedEvent(sessionId: string): EventSubscribeOutput {
  return v2Event({
    type: "permission.asked",
    data: {
      id: "perm-1",
      sessionID: sessionId,
      action: "shell",
      resources: ["bash"],
      metadata: { command: "ls -la", cwd: "/workspace" },
    },
  });
}

function toolInputStartedEvent(sessionId: string, toolId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.tool.input.started",
    data: {
      sessionID: sessionId,
      assistantMessageID: "assistant-1",
      id: toolId,
      name: "bash",
    },
  });
}

function toolCalledEvent(sessionId: string, toolId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.tool.called",
    data: {
      sessionID: sessionId,
      assistantMessageID: "assistant-1",
      id: toolId,
      input: { command: "echo hi" },
      executed: true,
    },
  });
}

function toolSuccessEvent(sessionId: string, toolId: string): EventSubscribeOutput {
  return v2Event({
    type: "session.tool.success",
    data: {
      sessionID: sessionId,
      assistantMessageID: "assistant-1",
      id: toolId,
      content: [{ type: "text", text: "hi" }],
      executed: true,
    },
  });
}

interface TurnResult {
  events: AgentStreamEvent[];
  assistantMessages: AssistantMessageTimelineItem[];
  toolCalls: ToolCallTimelineItem[];
  allTimelineItems: AgentTimelineItem[];
  turnCompleted: boolean;
  turnFailed: boolean;
  turnCanceled: boolean;
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
    turnCanceled: false,
  };

  for await (const streamEvent of iterator) {
    result.events.push(streamEvent);

    if (streamEvent.type === "timeline") {
      result.allTimelineItems.push(streamEvent.item);
      if (streamEvent.item.type === "assistant_message") {
        result.assistantMessages.push(streamEvent.item);
      } else if (streamEvent.item.type === "tool_call") {
        result.toolCalls.push(streamEvent.item);
      }
    }

    if (streamEvent.type === "turn_completed") {
      result.turnCompleted = true;
      break;
    }
    if (streamEvent.type === "turn_failed") {
      result.turnFailed = true;
      result.error = streamEvent.error;
      break;
    }
    if (streamEvent.type === "turn_canceled") {
      result.turnCanceled = true;
      break;
    }
  }

  return result;
}

async function createSession(
  sessionId = "session-1",
  configure?: (openCode: TestOpenCodeV2Client) => void,
): Promise<{
  readonly session: Awaited<ReturnType<OpenCodeV2AgentClient["createSession"]>>;
  readonly openCode: TestOpenCodeV2Client;
  readonly runtime: TestOpenCodeV2Harness;
}> {
  const runtime = new TestOpenCodeV2Harness();
  const openCode = new TestOpenCodeV2Client();
  openCode.sessionCreateResponse = {
    ...openCode.sessionCreateResponse,
    id: sessionId,
  };
  configure?.(openCode);
  runtime.enqueueClient(openCode);
  const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
    serverManager: runtime,
    createClient: runtime.createClient,
  });
  const session = await client.createSession(buildConfig("/workspace/repo"));
  return { session, openCode, runtime };
}

async function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await assertion();
}

async function waitForLong(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await assertion();
}

function hasTurnCanceled(events: AgentStreamEvent[]): boolean {
  return events.some((streamEvent) => streamEvent.type === "turn_canceled");
}

function hasModeChanged(events: AgentStreamEvent[]): boolean {
  return events.some((streamEvent) => streamEvent.type === "mode_changed");
}

describe("OpenCodeV2AgentClient session core", () => {
  test("createSession creates a session via session.create with the workspace location", async () => {
    const { session, openCode, runtime } = await createSession();

    expect(session.id).toBe("session-1");
    expect(session.provider).toBe("opencode-v2");
    expect(openCode.calls.sessionCreate).toEqual([
      {
        location: { directory: "/workspace/repo" },
        model: { providerID: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
      },
    ]);
    expect(runtime.acquisitions).toHaveLength(1);
    expect(runtime.acquisitions[0]?.kind).toBe("current");

    await session.close();
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
  });

  test("createSession shares the current server when the launch env only has paseo defaults", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig("/workspace/repo"), {
      agentId: "agent-1",
      env: { PASEO_AGENT_ID: "agent-1", PASEO_AGENT_CWD: "/workspace/repo" },
    });
    expect(runtime.acquisitions[0]?.kind).toBe("current");
    await session.close();
  });

  test("createSession uses a dedicated server when the launch env has custom keys", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig("/workspace/repo"), {
      agentId: "agent-1",
      env: {
        PASEO_AGENT_ID: "agent-1",
        PASEO_AGENT_CWD: "/workspace/repo",
        CUSTOM_VAR: "custom-value",
      },
    });
    expect(runtime.acquisitions[0]?.kind).toBe("dedicated");
    await session.close();
  });

  test("resumeSession shares the current server when the launch env only has paseo defaults", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.resumeSession(
      {
        provider: "opencode-v2",
        sessionId: "session-1",
        nativeHandle: "session-1",
        metadata: { cwd: "/workspace/repo" },
      },
      undefined,
      {
        agentId: "agent-1",
        env: { PASEO_AGENT_ID: "agent-1", PASEO_AGENT_CWD: "/workspace/repo" },
      },
    );
    expect(runtime.acquisitions[0]?.kind).toBe("current");
    await session.close();
  });

  test("createSession passes the mode as the v2 agent when a modeId is configured", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({
      provider: "opencode-v2",
      cwd: "/workspace/repo",
      modeId: "plan",
    });

    expect(openCode.calls.sessionCreate).toEqual([
      {
        location: { directory: "/workspace/repo" },
        agent: "plan",
      },
    ]);
    await session.close();
  });

  test("createSession releases the server when session.create fails (invalid model)", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    openCode.sessionCreateError = new Error("Model not found: baseten/does-not-exist-xyz");
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });

    await expect(
      client.createSession({
        provider: "opencode-v2",
        cwd: "/workspace/repo",
        model: "baseten/does-not-exist-xyz",
      }),
    ).rejects.toThrow("Model not found: baseten/does-not-exist-xyz");

    expect(runtime.acquisitions).toHaveLength(1);
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
  });

  test("startTurn sends session.prompt with resume:true and streams text deltas", async () => {
    const { session, openCode } = await createSession();

    const iterator = streamSession(session, "Say hello");
    const turnPromise = collectTurnEvents(iterator);

    openCode.emitEvent(userMessageEvent("session-1", "inbox-1", "Say hello"));
    openCode.emitEvent(textDeltaEvent("session-1", "assistant-1", 0, "Hello"));
    openCode.emitEvent(executionSucceededEvent("session-1"));

    const turn = await turnPromise;

    expect(turn.turnCompleted).toBe(true);
    expect(turn.turnFailed).toBe(false);
    expect(turn.assistantMessages).toEqual([
      { type: "assistant_message", text: "Hello", messageId: "assistant-1" },
    ]);
    expect(openCode.calls.sessionPrompt).toEqual([
      {
        sessionID: "session-1",
        text: "Say hello",
        resume: true,
      },
    ]);
    expect(turn.events[0]).toMatchObject({ type: "turn_started", provider: "opencode-v2" });

    await session.close();
  });

  test("startTurn rejects an empty prompt", async () => {
    const { session } = await createSession();
    await expect(session.startTurn("")).rejects.toThrow("A prompt is required");
    await expect(session.startTurn("   ")).rejects.toThrow("A prompt is required");
    await session.close();
  });

  test("run completes a real turn with final text and timeline", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Say hello");
    openCode.emitEvent(userMessageEvent("session-1", "inbox-1", "Say hello"));
    openCode.emitEvent(textDeltaEvent("session-1", "assistant-1", 0, "Hello"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await runPromise;

    expect(result.sessionId).toBe("session-1");
    expect(result.finalText).toBe("Hello");
    expect(result.timeline).toContainEqual({
      type: "user_message",
      text: "Say hello",
      messageId: "inbox-1",
    });
    expect(result.timeline).toContainEqual({
      type: "assistant_message",
      text: "Hello",
      messageId: "assistant-1",
    });
    expect(openCode.calls.sessionPrompt).toHaveLength(1);

    await session.close();
  });

  test("run surfaces usage on turn completion", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Count tokens");
    openCode.emitEvent(usageUpdatedEvent("session-1"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await runPromise;

    expect(result.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      contextWindowUsedTokens: 185,
      totalCostUsd: 0.012,
    });

    await session.close();
  });

  test("run streams reasoning and tool calls as timeline items", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Use a tool");
    openCode.emitEvent(userMessageEvent("session-1", "inbox-1", "Use a tool"));
    openCode.emitEvent(reasoningDeltaEvent("session-1", "assistant-1", 0, "Let me think"));
    openCode.emitEvent(textDeltaEvent("session-1", "assistant-1", 0, "Done"));
    openCode.emitEvent(toolInputStartedEvent("session-1", "tool-1"));
    openCode.emitEvent(toolCalledEvent("session-1", "tool-1"));
    openCode.emitEvent(toolSuccessEvent("session-1", "tool-1"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await runPromise;

    expect(result.timeline).toContainEqual({ type: "reasoning", text: "Let me think" });
    expect(result.timeline).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        callId: "tool-1",
        name: "bash",
        status: "running",
      }),
    );
    expect(result.timeline).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        callId: "tool-1",
        name: "bash",
        status: "completed",
      }),
    );

    await session.close();
  });

  test("a failed turn surfaces the error and leaves the agent resumable", async () => {
    const { session, openCode } = await createSession();

    const firstRun = session.run("Trigger failure");
    openCode.emitEvent(executionFailedEvent("session-1", "Model unavailable: nope"));
    await expect(firstRun).rejects.toThrow("Model unavailable: nope");

    // The failed turn must not corrupt the session: a new prompt succeeds.
    const secondRun = session.run("Now say hi");
    openCode.emitEvent(userMessageEvent("session-1", "inbox-2", "Now say hi"));
    openCode.emitEvent(textDeltaEvent("session-1", "assistant-2", 0, "hi"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await secondRun;

    expect(result.finalText).toBe("hi");
    expect(openCode.calls.sessionPrompt).toHaveLength(2);

    await session.close();
  });

  test("a no-credentials error surfaces as a clear turn failure", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Use the model");
    openCode.emitEvent(
      v2Event({
        type: "session.execution.failed",
        data: {
          sessionID: "session-1",
          error: {
            type: "provider.no-credentials",
            message: "No credentials found for provider 'anthropic'",
          },
        },
      }),
    );
    await expect(runPromise).rejects.toThrow("No credentials found for provider 'anthropic'");

    await session.close();
  });
  test("an auth failure with an empty server message surfaces a clear credentials error", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession({
      provider: "opencode-v2",
      cwd: "/workspace/repo",
      model: "openai/gpt-5.5",
    });
    const runPromise = session.run("Use the model");
    openCode.emitEvent(
      v2Event({
        type: "session.execution.failed",
        data: {
          sessionID: "session-1",
          error: { type: "provider.auth", message: "" },
        },
      }),
    );
    await expect(runPromise).rejects.toThrow(
      "Authentication failed for openai — check your opencode2 credentials",
    );
    await session.close();
  });
  test("interrupt calls session.interrupt while a turn is running", async () => {
    const { session, openCode } = await createSession();

    const events: AgentStreamEvent[] = [];
    session.subscribe((streamEvent) => events.push(streamEvent));
    await session.startTurn("Run a long task");

    await session.interrupt();
    expect(openCode.calls.sessionInterrupt).toEqual([{ sessionID: "session-1" }]);

    openCode.emitEvent(executionInterruptedEvent("session-1"));
    await waitFor(() => expect(hasTurnCanceled(events)).toBe(true));

    await session.close();
  });

  test("an idle interrupt is a clean no-op", async () => {
    const { session, openCode } = await createSession();

    await expect(session.interrupt()).resolves.toBeUndefined();
    expect(openCode.calls.sessionInterrupt).toHaveLength(1);

    // The session remains usable after the idle interrupt.
    const runPromise = session.run("Say hi");
    openCode.emitEvent(textDeltaEvent("session-1", "assistant-1", 0, "hi"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await runPromise;
    expect(result.finalText).toBe("hi");

    await session.close();
  });

  test("steerActiveTurn sends a steer prompt while busy", async () => {
    const { session, openCode } = await createSession();

    const { turnId } = await session.startTurn("First instruction");
    const steer = await session.steerActiveTurn?.("Follow-up steer", {
      expectedTurnId: turnId,
    });

    expect(steer).toEqual({ status: "accepted" });
    expect(openCode.calls.sessionPrompt).toHaveLength(2);
    expect(openCode.calls.sessionPrompt[1]).toEqual({
      sessionID: "session-1",
      text: "Follow-up steer",
      delivery: "steer",
      resume: true,
    });

    await session.close();
  });

  test("steerActiveTurn is unavailable when no turn is active", async () => {
    const { session } = await createSession();
    const steer = await session.steerActiveTurn?.("Steer with no turn", {
      expectedTurnId: "opencode-v2-turn-1",
    });
    expect(steer).toEqual({ status: "unavailable" });
    await session.close();
  });

  test("streamHistory replays messages from message.list", async () => {
    const { session, openCode } = await createSession();
    openCode.messageListResponse = {
      data: [
        {
          id: "msg_user",
          type: "user",
          text: "Hello there",
          time: { created: 1 },
        },
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
          time: { created: 2 },
          content: [
            { type: "reasoning", text: "thinking", state: {} },
            { type: "text", text: "Hi back", state: {} },
          ],
        },
      ],
      cursor: {},
    };

    const history: AgentStreamEvent[] = [];
    for await (const historyEvent of session.streamHistory()) {
      history.push(historyEvent);
    }

    expect(history).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        timestamp: "1970-01-01T00:00:01.000Z",
        item: { type: "user_message", text: "Hello there", messageId: "msg_user" },
      },
      {
        type: "timeline",
        provider: "opencode-v2",
        timestamp: "1970-01-01T00:00:02.000Z",
        item: { type: "reasoning", text: "thinking" },
      },
      {
        type: "timeline",
        provider: "opencode-v2",
        timestamp: "1970-01-01T00:00:02.000Z",
        item: { type: "assistant_message", text: "Hi back", messageId: "msg_assistant" },
      },
    ]);
    expect(openCode.calls.messageList).toEqual([{ sessionID: "session-1" }]);

    await session.close();
  });

  test("streamHistory maps persisted tool parts to tool timeline items", async () => {
    const { session } = await createSession("session-1", (openCode) => {
      openCode.messageListResponse = {
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { providerID: "baseten", id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
            time: { created: 2 },
            content: [
              {
                type: "tool",
                id: "call-1",
                name: "bash",
                state: {
                  status: "completed",
                  input: { command: "ls -la" },
                  content: [{ type: "text", text: "file1" }],
                },
                time: { created: 3 },
              },
            ],
          },
        ],
        cursor: {},
      };
    });

    const history: AgentStreamEvent[] = [];
    for await (const historyEvent of session.streamHistory()) {
      history.push(historyEvent);
    }

    expect(history).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        timestamp: "1970-01-01T00:00:02.000Z",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "ls -la", output: "file1" },
          error: null,
        },
      },
    ]);

    await session.close();
  });

  test("describePersistence reports the provider session id and metadata", async () => {
    const { session } = await createSession();

    const handle = session.describePersistence();
    expect(handle).toEqual({
      provider: "opencode-v2",
      sessionId: "session-1",
      nativeHandle: "session-1",
      metadata: {
        cwd: "/workspace/repo",
        model: TEST_MODEL,
      },
    });

    await session.close();
  });

  test("close releases the server and does not remove the persisted session by default", async () => {
    const { session, openCode, runtime } = await createSession();

    await session.close();

    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
    expect(openCode.calls.sessionRemove).toEqual([]);
  });

  test("close removes the provider session when persistence is disabled", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
    });
    const session = await client.createSession(buildConfig("/workspace/repo"), undefined, {
      persistSession: false,
    });

    await session.close();

    expect(openCode.calls.sessionRemove).toEqual([{ sessionID: "session-1" }]);
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
  });

  test("a permission.asked surfaces a pending tool request and respondToPermission replies", async () => {
    const { session, openCode } = await createSession();

    const runPromise = session.run("Run a shell command");
    openCode.emitEvent(permissionAskedEvent("session-1"));

    // Wait for the pending permission to surface.
    await waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    const pending = session.getPendingPermissions();
    expect(pending[0]).toMatchObject({
      id: "perm-1",
      provider: "opencode-v2",
      name: "shell",
      kind: "tool",
      title: "Shell",
    });

    await session.respondToPermission("perm-1", { behavior: "allow" });
    expect(openCode.calls.permissionReply).toEqual([
      { sessionID: "session-1", requestID: "perm-1", reply: "once" },
    ]);
    expect(session.getPendingPermissions()).toHaveLength(0);

    openCode.emitEvent(textDeltaEvent("session-1", "assistant-1", 0, "done"));
    openCode.emitEvent(executionSucceededEvent("session-1"));
    const result = await runPromise;
    expect(result.finalText).toBe("done");

    await session.close();
  });

  test("respondToPermission rejects an unknown request id", async () => {
    const { session } = await createSession();
    await expect(
      session.respondToPermission("does-not-exist", { behavior: "allow" }),
    ).rejects.toThrow("No pending permission request with id 'does-not-exist'");
    await session.close();
  });

  test("getRuntimeInfo reports provider, session id, model and mode", async () => {
    const { session } = await createSession();
    const info = await session.getRuntimeInfo();
    expect(info).toMatchObject({
      provider: "opencode-v2",
      sessionId: "session-1",
      model: TEST_MODEL,
      modeId: null,
    });
    await session.close();
  });

  test("fetchCatalog returns filtered models and modes from the live server", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    openCode.modelListResponse = {
      ...openCode.modelListResponse,
      data: [
        buildModelInfo({
          providerID: "baseten",
          modelID: "deepseek-ai/DeepSeek-V4-Flash-0731",
          name: "DeepSeek V4 Flash 0731",
          variants: [{ id: "low" }, { id: "high" }],
        }),
        buildModelInfo({ providerID: "meta", modelID: "muse-spark-1.2", name: "Muse Spark" }),
        buildModelInfo({ providerID: "opencode", modelID: "x-preview-f-free", name: "Ox Free" }),
      ],
    };
    openCode.agentListResponse = {
      ...openCode.agentListResponse,
      data: [
        buildAgentInfo({ name: "general", mode: "subagent" }),
        buildAgentInfo({ name: "plan" }),
        buildAgentInfo({ name: "build" }),
        buildAgentInfo({ name: "compaction", hidden: true }),
      ],
    };
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      readCredentialedProviderIds: async () => new Set(["baseten"]),
    });

    const catalog = await client.fetchCatalog({ scope: "global", force: false });

    expect(catalog.models.map((model) => model.id)).toEqual([
      "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
      "opencode/x-preview-f-free",
    ]);
    expect(catalog.models[0]?.thinkingOptions?.map((option) => option.id)).toEqual([
      "default",
      "low",
      "high",
    ]);
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["build", "plan", "general"]);
    expect(runtime.acquisitions[0]?.kind).toBe("current");
    expect(runtime.acquisitions[0]?.releaseCount).toBe(1);
  });

  test("fetchCatalog acquires a new server when force is set", async () => {
    const runtime = new TestOpenCodeV2Harness();
    const openCode = new TestOpenCodeV2Client();
    runtime.enqueueClient(openCode);
    const client = new OpenCodeV2AgentClient(createTestLogger(), undefined, {
      serverManager: runtime,
      createClient: runtime.createClient,
      readCredentialedProviderIds: async () => new Set(),
    });

    await client.fetchCatalog({ scope: "workspace", cwd: "/workspace/repo", force: true });

    expect(runtime.acquisitions[0]?.kind).toBe("new");
    expect(openCode.calls.modelList).toEqual([{ location: { directory: "/workspace/repo" } }]);
    expect(openCode.calls.agentList).toEqual([{ location: { directory: "/workspace/repo" } }]);
  });

  test("getAvailableModes lists selectable agents from agent.list sorted build/plan first", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.agentListResponse = {
        ...client.agentListResponse,
        data: [
          buildAgentInfo({ name: "general", mode: "subagent" }),
          buildAgentInfo({ name: "plan" }),
          buildAgentInfo({ name: "build" }),
          buildAgentInfo({ name: "title", hidden: true }),
        ],
      };
    });

    const modes = await session.getAvailableModes();
    expect(modes.map((mode) => mode.id)).toEqual(["build", "plan", "general"]);
    expect(openCode.calls.agentList).toEqual([{ location: { directory: "/workspace/repo" } }]);
    await session.close();
  });

  test("cold-start: refreshes availableModes with a mode_changed once the event source is ready", async () => {
    const { session, openCode, runtime } = await createSession("session-1", (client) => {
      client.agentListResponse = {
        ...client.agentListResponse,
        data: [
          buildAgentInfo({ name: "general", mode: "subagent" }),
          buildAgentInfo({ name: "plan" }),
          buildAgentInfo({ name: "explore" }),
          buildAgentInfo({ name: "build" }),
        ],
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    // Before the event source is ready, no mode refresh has happened: the
    // daemon's registration-time fetch failed and left availableModes empty.
    expect(openCode.calls.agentList).toHaveLength(0);
    expect(hasModeChanged(events)).toBe(false);

    runtime.resolveEventsReadyNow();

    await waitFor(() => expect(hasModeChanged(events)).toBe(true));

    const modeChanged = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "mode_changed" }> =>
        event.type === "mode_changed",
    );
    expect(modeChanged?.availableModes.map((mode) => mode.id)).toEqual([
      "build",
      "plan",
      "explore",
      "general",
    ]);
    expect(modeChanged?.currentModeId).toBeNull();
    expect(openCode.calls.agentList.length).toBeGreaterThan(0);

    await session.close();
  });

  test("warm: mode refresh after ready keeps the available modes unchanged", async () => {
    const { session, runtime } = await createSession("session-1", (client) => {
      client.agentListResponse = {
        ...client.agentListResponse,
        data: [
          buildAgentInfo({ name: "general", mode: "subagent" }),
          buildAgentInfo({ name: "plan" }),
          buildAgentInfo({ name: "explore" }),
          buildAgentInfo({ name: "build" }),
        ],
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    runtime.resolveEventsReadyNow();

    await waitFor(() => expect(hasModeChanged(events)).toBe(true));

    const modeChanged = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "mode_changed" }> =>
        event.type === "mode_changed",
    );
    expect(modeChanged?.availableModes.map((mode) => mode.id)).toEqual([
      "build",
      "plan",
      "explore",
      "general",
    ]);

    await session.close();
  });

  test("cold-start: retries the mode fetch when the first post-ready call fails", async () => {
    const { session, openCode, runtime } = await createSession("session-1", (client) => {
      let agentListCalls = 0;
      client.agentListImplementation = async () => {
        agentListCalls += 1;
        if (agentListCalls === 1) {
          throw new Error("server not ready yet");
        }
        return {
          ...client.agentListResponse,
          data: [buildAgentInfo({ name: "plan" }), buildAgentInfo({ name: "build" })],
        };
      };
    });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    runtime.resolveEventsReadyNow();

    await waitForLong(() => expect(hasModeChanged(events)).toBe(true));

    const modeChanged = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "mode_changed" }> =>
        event.type === "mode_changed",
    );
    expect(modeChanged?.availableModes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    expect(openCode.calls.agentList.length).toBeGreaterThanOrEqual(2);

    await session.close();
  });

  test("setMode switches the session agent and persists the mode", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.agentListResponse = {
        ...client.agentListResponse,
        data: [buildAgentInfo({ name: "plan" }), buildAgentInfo({ name: "build" })],
      };
    });

    await session.setMode("plan");

    expect(openCode.calls.sessionSwitchAgent).toEqual([{ sessionID: "session-1", agent: "plan" }]);
    expect(await session.getCurrentMode()).toBe("plan");
    expect(await session.getRuntimeInfo()).toMatchObject({ modeId: "plan" });
    await session.close();
  });

  test("setMode rejects an unknown mode with a clear error and leaves the session usable", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.agentListResponse = {
        ...client.agentListResponse,
        data: [buildAgentInfo({ name: "build" })],
      };
    });

    await expect(session.setMode("not-a-real-mode")).rejects.toThrow(
      "Unknown mode 'not-a-real-mode' for OpenCode 2",
    );
    expect(openCode.calls.sessionSwitchAgent).toEqual([]);
    expect(await session.getCurrentMode()).toBeNull();
    await session.close();
  });

  test("setModel switches the session model via session.switchModel", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.modelListResponse = {
        ...client.modelListResponse,
        data: [
          buildModelInfo({
            providerID: "openai",
            modelID: "gpt-5.5",
            name: "GPT 5.5",
          }),
        ],
      };
    });

    await session.setModel("openai/gpt-5.5");

    expect(openCode.calls.sessionSwitchModel).toEqual([
      {
        sessionID: "session-1",
        model: { id: "gpt-5.5", providerID: "openai" },
      },
    ]);
    expect(await session.getRuntimeInfo()).toMatchObject({ model: "openai/gpt-5.5" });
    await session.close();
  });

  test("setModel rejects an invalid model id format", async () => {
    const { session } = await createSession();

    await expect(session.setModel("no-slash-here")).rejects.toThrow(
      "Invalid model id 'no-slash-here' for OpenCode 2",
    );
    await session.close();
  });

  test("setModel rejects an unknown model with a clear error", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.modelListResponse = {
        ...client.modelListResponse,
        data: [buildModelInfo()],
      };
    });

    await expect(session.setModel("baseten/does-not-exist-xyz")).rejects.toThrow(
      "Unknown model 'baseten/does-not-exist-xyz' for OpenCode 2",
    );
    expect(openCode.calls.sessionSwitchModel).toEqual([]);
    await session.close();
  });

  test("setThinkingOption switches the model with the selected variant", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.modelListResponse = {
        ...client.modelListResponse,
        data: [
          buildModelInfo({
            providerID: "baseten",
            modelID: "deepseek-ai/DeepSeek-V4-Flash-0731",
            name: "DeepSeek V4 Flash 0731",
            variants: [{ id: "none" }, { id: "low" }, { id: "high" }, { id: "max" }],
          }),
        ],
      };
    });

    await session.setThinkingOption("high");

    expect(openCode.calls.sessionSwitchModel).toEqual([
      {
        sessionID: "session-1",
        model: {
          id: "deepseek-ai/DeepSeek-V4-Flash-0731",
          providerID: "baseten",
          variant: "high",
        },
      },
    ]);
    expect(await session.getRuntimeInfo()).toMatchObject({ thinkingOptionId: "high" });
    await session.close();
  });

  test("setThinkingOption with default clears the variant", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.modelListResponse = {
        ...client.modelListResponse,
        data: [
          buildModelInfo({
            providerID: "baseten",
            modelID: "deepseek-ai/DeepSeek-V4-Flash-0731",
            name: "DeepSeek V4 Flash 0731",
            variants: [{ id: "high" }],
          }),
        ],
      };
    });

    await session.setThinkingOption("default");

    expect(openCode.calls.sessionSwitchModel).toEqual([
      {
        sessionID: "session-1",
        model: { id: "deepseek-ai/DeepSeek-V4-Flash-0731", providerID: "baseten" },
      },
    ]);
    expect(await session.getRuntimeInfo()).toMatchObject({ thinkingOptionId: null });
    await session.close();
  });

  test("setThinkingOption rejects an unknown variant for the current model", async () => {
    const { session, openCode } = await createSession("session-1", (client) => {
      client.modelListResponse = {
        ...client.modelListResponse,
        data: [
          buildModelInfo({
            providerID: "baseten",
            modelID: "deepseek-ai/DeepSeek-V4-Flash-0731",
            name: "DeepSeek V4 Flash 0731",
            variants: [{ id: "high" }],
          }),
        ],
      };
    });

    await expect(session.setThinkingOption("ultra")).rejects.toThrow(
      "Unknown thinking option 'ultra' for model 'baseten/deepseek-ai/DeepSeek-V4-Flash-0731'",
    );
    expect(openCode.calls.sessionSwitchModel).toEqual([]);
    await session.close();
  });
});

function buildModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    modelID: "deepseek-ai/DeepSeek-V4-Flash-0731",
    providerID: "baseten",
    name: "DeepSeek V4 Flash 0731",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: { context: 1_000_000, output: 131_072 },
    ...overrides,
  };
}

function buildAgentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "build",
    name: "build",
    mode: "primary",
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
    ...overrides,
  };
}
