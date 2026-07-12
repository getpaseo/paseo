import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, onTestFinished, test } from "vitest";

import type { AgentSession, AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { PiRpcAgentClient, PiRpcAgentSession, transformPiModels } from "./agent.js";
import { FakePi } from "./test-utils/fake-pi.js";

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createClient(pi = new FakePi()): PiRpcAgentClient {
  return new PiRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: pi,
  });
}

function rewindCapabilities(capabilities: PiRpcAgentSession["capabilities"]) {
  return {
    supportsRewindConversation: capabilities.supportsRewindConversation,
    supportsRewindFiles: capabilities.supportsRewindFiles,
    supportsRewindBoth: capabilities.supportsRewindBoth,
  };
}

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "pi",
    cwd: "/tmp/paseo-pi-rpc-test",
    ...overrides,
  };
}

function readUtf8File(pathname: string): string {
  const fd = openSync(pathname, "r");
  try {
    const buffer = Buffer.alloc(fstatSync(fd).size);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function createSession(pi = new FakePi()): Promise<{
  pi: FakePi;
  session: PiRpcAgentSession;
  events: SessionEvents;
}> {
  const client = createClient(pi);
  const session = (await client.createSession(createConfig())) as PiRpcAgentSession;
  const events = new SessionEvents(session);
  return { pi, session, events };
}

test("forwards launch-context env to the Pi process launch", async () => {
  const pi = new FakePi();
  const client = createClient(pi);
  const session = await client.createSession(createConfig(), {
    env: {
      CHUNK14_PROBE: "expected",
    },
  });

  expect(pi.recordedLaunches[0]?.env).toEqual({
    CHUNK14_PROBE: "expected",
  });

  await session.close();
});

class SessionEvents {
  private readonly events: AgentStreamEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: AgentStreamEvent) => boolean;
    resolve: (event: AgentStreamEvent) => void;
  }> = [];

  constructor(session: PiRpcAgentSession) {
    session.subscribe((event) => {
      this.events.push(event);
      for (let index = 0; index < this.waiters.length; index += 1) {
        const waiter = this.waiters[index];
        if (waiter.predicate(event)) {
          this.waiters.splice(index, 1);
          index -= 1;
          waiter.resolve(event);
        }
      }
    });
  }

  timelineItems() {
    return this.events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline",
      )
      .map((event) => event.item);
  }

  timelineAndCompletionEvents() {
    return this.events.flatMap((event) => {
      if (event.type === "timeline") {
        return [{ type: "timeline" as const, item: event.item }];
      }
      if (event.type === "turn_completed") {
        return [{ type: "turn_completed" as const }];
      }
      return [];
    });
  }

  nextTurnCompletion(): Promise<Extract<AgentStreamEvent, { type: "turn_completed" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "turn_completed" }> =>
        event.type === "turn_completed",
    );
  }

  nextTurnFailure(): Promise<Extract<AgentStreamEvent, { type: "turn_failed" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "turn_failed" }> =>
        event.type === "turn_failed",
    );
  }

  nextTurnCancellation(): Promise<Extract<AgentStreamEvent, { type: "turn_canceled" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "turn_canceled" }> =>
        event.type === "turn_canceled",
    );
  }

  nextPermissionRequest(): Promise<Extract<AgentStreamEvent, { type: "permission_requested" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested",
    );
  }

  nextPermissionResolution(): Promise<Extract<AgentStreamEvent, { type: "permission_resolved" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "permission_resolved" }> =>
        event.type === "permission_resolved",
    );
  }

  nextTimelineEvent(): Promise<Extract<AgentStreamEvent, { type: "timeline" }>> {
    return this.nextEvent(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline",
    );
  }

  private nextEvent<T extends AgentStreamEvent>(
    predicate: (event: AgentStreamEvent) => event is T,
  ): Promise<T> {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.waiters.push({
        predicate,
        resolve: (event) => resolve(event as T),
      });
    });
  }
}

describe("PiRpcAgentSession", () => {
  test("bridges Pi RPC select extension UI requests through question permissions", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("ask");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: "Pick one",
      options: ["A", "B"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "ui-1",
      provider: "pi",
      kind: "question",
      title: "Pick one",
      input: {
        questions: [
          {
            question: "Pick one",
            header: "Response",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
        ],
      },
      metadata: { extensionUiMethod: "select" },
    });
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.respondToPermission("ui-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "B" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([{ id: "ui-1", response: { value: "B" } }]);
    expect(session.getPendingPermissions()).toEqual([]);
    await expect(events.nextPermissionResolution()).resolves.toMatchObject({
      requestId: "ui-1",
      resolution: { behavior: "allow" },
    });
  });

  test("bridges Pi RPC input and confirm extension UI responses", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "input-1",
      method: "input",
      title: "Your name",
      placeholder: "name",
    });
    await events.nextPermissionRequest();
    await session.respondToPermission("input-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Ada" } },
    });

    fakeSession.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Proceed?",
    });
    await events.nextPermissionRequest();
    await session.respondToPermission("confirm-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "No" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "input-1", response: { value: "Ada" } },
      { id: "confirm-1", response: { confirmed: false } },
    ]);
  });

  test("marks optional Pi RPC input prompts as skippable", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "comment-1",
      method: "input",
      title: "Pick one\n\nSelected option:\n- A",
      placeholder: "Optional comment (press Enter to skip)...",
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      title: "Optional comment",
      input: {
        questions: [
          {
            question: "Optional comment",
            header: "Response",
            options: [],
            multiSelect: false,
            placeholder: "Optional comment (press Enter to skip)...",
            allowEmpty: true,
            dismissLabel: "Skip",
          },
        ],
      },
    });

    await session.respondToPermission("comment-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "comment-1", response: { value: "" } },
    ]);
  });

  test("combines Pi ask_user select and optional comment into one permission", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "ask_user",
      args: {
        question: "Pick one",
        options: ["A", "B"],
        allowComment: true,
        allowFreeform: false,
      },
    });
    fakeSession.emit({
      type: "extension_ui_request",
      id: "select-1",
      method: "select",
      title: "Pick one",
      options: ["A", "B"],
    });

    const permission = await events.nextPermissionRequest();
    expect(permission.request).toMatchObject({
      id: "select-1",
      name: "Pi ask_user",
      kind: "question",
      title: "Pick one",
      input: {
        questions: [
          {
            question: "Pick one",
            header: "Response",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
          {
            question: "Optional comment",
            header: "Comment",
            options: [],
            multiSelect: false,
            placeholder: "Optional comment (press Enter to skip)...",
            allowEmpty: true,
          },
        ],
      },
      metadata: {
        combinedAskUser: "ask_user_select_optional_comment",
        answerHeader: "Response",
        commentHeader: "Comment",
      },
    });

    await session.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "B", Comment: "Looks good" } },
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "select-1", response: { value: "B" } },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);

    fakeSession.emit({
      type: "extension_ui_request",
      id: "comment-1",
      method: "input",
      title: "Pick one\n\nSelected option:\n- B",
      placeholder: "Optional comment (press Enter to skip)...",
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "select-1", response: { value: "B" } },
      { id: "comment-1", response: { value: "Looks good" } },
    ]);
    expect(session.getPendingPermissions()).toEqual([]);
  });

  test("cancels Pi RPC extension UI dialogs when question permission is denied", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "ui-cancel",
      method: "select",
      title: "Pick one",
      options: ["A", "B"],
    });
    await events.nextPermissionRequest();

    await session.respondToPermission("ui-cancel", {
      behavior: "deny",
      message: "Dismissed by user",
    });

    expect(fakeSession.extensionUiResponses).toEqual([
      { id: "ui-cancel", response: { cancelled: true } },
    ]);
  });

  test("ignores Pi RPC fire-and-forget extension UI requests", async () => {
    const { pi } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.emit({
      type: "extension_ui_request",
      id: "notify-1",
      method: "notify",
      message: "hello",
    });

    expect(fakeSession.extensionUiResponses).toEqual([]);
    expect(fakeSession.canceledExtensionUiRequests).toEqual([]);
  });

  test("streams assistant text, reasoning, and tool calls from Pi events", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [], responseId: "response-1" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-1" },
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "response-1" },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
    });
    fakeSession.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    fakeSession.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { output: "hi\n", exitCode: 0 },
      isError: false,
    });
    fakeSession.finishTurn();

    await events.nextTurnCompletion();

    expect(events.timelineItems()).toEqual([
      { type: "assistant_message", text: "hel", messageId: "response-1" },
      { type: "assistant_message", text: "lo", messageId: "response-1" },
      { type: "reasoning", text: "thinking" },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "bash",
        status: "running",
        detail: { type: "shell", command: "echo hi" },
        error: null,
      },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "bash",
        status: "completed",
        detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
        error: null,
      },
    ]);
  });

  test("keeps one generated message id when Pi omits message start and response id", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "hel" },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });

    const [firstChunk, secondChunk] = events.timelineItems();
    expect(firstChunk).toMatchObject({
      type: "assistant_message",
      text: "hel",
      messageId: expect.any(String),
    });
    const firstMessageId = (firstChunk as { messageId: string }).messageId;
    expect(secondChunk).toEqual({
      type: "assistant_message",
      text: "lo",
      messageId: firstMessageId,
    });
  });

  test("uses a response id that first appears on the assistant update", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    fakeSession.emit({
      type: "message_update",
      message: { role: "assistant", content: [], responseId: "late-response-id" },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });

    expect(events.timelineItems()).toEqual([
      {
        type: "assistant_message",
        text: "hello",
        messageId: "late-response-id",
      },
    ]);
  });

  test("emits live user messages with captured Pi tree entry ids", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.capturedUserEntries = [{ id: "entry-user-1", parentId: null, text: "hello" }];
    await session.startTurn("hello");
    fakeSession.emit({
      type: "message_end",
      message: { role: "user", content: "hello" },
    });

    await events.nextTimelineEvent();

    expect(events.timelineItems()).toEqual([
      { type: "user_message", text: "hello", messageId: "entry-user-1" },
    ]);
  });

  test("surfaces Pi extension command messages and completes when no agent turn starts", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn("/show-status");
    fakeSession.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: [{ type: "text", text: "Extension command output" }],
      },
    });

    expect(events.timelineAndCompletionEvents()).toEqual([
      {
        type: "timeline",
        item: { type: "assistant_message", text: "Extension command output" },
      },
      { type: "turn_completed" },
    ]);
  });

  test("canceling a silent Pi extension command leaves the session usable", async () => {
    const { pi, session, events } = await createSession();
    const fakeSession = pi.latestSession();

    fakeSession.holdNextPrompt();
    const firstTurn = await session.startTurn("/silent-search");
    fakeSession.emit({
      type: "extension_ui_request",
      id: "notify-1",
      method: "notify",
      message: "Search finished",
    });
    await session.interrupt();
    const cancellation = await events.nextTurnCancellation();
    await session.startTurn("next request");
    await fakeSession.failHeldPrompt(new Error("Canceled prompt timed out"));

    expect(cancellation).toEqual({
      type: "turn_canceled",
      provider: "pi",
      reason: "interrupted",
      turnId: firstTurn.turnId,
    });
    expect(fakeSession.prompts).toEqual([
      { message: "/silent-search", imageCount: 0 },
      { message: "next request", imageCount: 0 },
    ]);
    await expect(session.startTurn("overlapping request")).rejects.toThrow(
      "A Pi turn is already active",
    );
  });

  test("adds Pi assistant context to generic provider finish errors", async () => {
    const { pi, session, events } = await createSession();

    await session.startTurn("write qa");
    pi.latestSession().finishTurn({
      role: "assistant",
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      responseId: "gen-test",
      stopReason: "error",
      errorMessage: "Provider finish_reason: error",
      content: [
        {
          type: "thinking",
          thinking: "I will use the write tool for qa.txt.",
        },
      ],
    });

    await expect(events.nextTurnFailure()).resolves.toMatchObject({
      error: expect.stringContaining(
        'Provider finish_reason: error (stopReason=error, model=openrouter/google/gemini-2.5-flash-lite, responseId=gen-test, partial="I will use the write tool for qa.txt.")',
      ),
    });
  });

  test("resumes by launching Pi with the persisted session file and cwd metadata", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await client.resumeSession(
      {
        provider: "pi",
        sessionId: "pi-session-1",
        nativeHandle: "/tmp/native-pi-session",
        metadata: {
          cwd: "/workspace/project",
          model: "openrouter/model-a",
          thinkingOptionId: "high",
        },
      },
      {},
      { env: { RESUME_PROBE: "expected" } },
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/workspace/project",
      env: { RESUME_PROBE: "expected" },
      session: "/tmp/native-pi-session",
    });
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--model",
      "openrouter/model-a",
      "--thinking",
      "high",
      "--session",
      "/tmp/native-pi-session",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
  });

  test("creates Pi sessions with agent and daemon system prompts appended", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await client.createSession(
      createConfig({
        systemPrompt: "Agent prompt",
        daemonAppendSystemPrompt: "Daemon prompt",
      }),
    );

    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/tmp/paseo-pi-rpc-test",
      systemPrompt: "Agent prompt\n\nDaemon prompt",
    });
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--append-system-prompt",
      "Agent prompt\n\nDaemon prompt",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
  });

  test("resumes Pi sessions with daemon system prompts appended", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await client.resumeSession(
      {
        provider: "pi",
        sessionId: "pi-session-1",
        nativeHandle: "/tmp/native-pi-session",
        metadata: {
          cwd: "/workspace/project",
          model: "openrouter/model-a",
          thinkingOptionId: "high",
          systemPrompt: "Agent prompt",
        },
      },
      {
        daemonAppendSystemPrompt: "Daemon prompt",
      },
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/workspace/project",
      session: "/tmp/native-pi-session",
      systemPrompt: "Agent prompt\n\nDaemon prompt",
    });
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--model",
      "openrouter/model-a",
      "--thinking",
      "high",
      "--session",
      "/tmp/native-pi-session",
      "--append-system-prompt",
      "Agent prompt\n\nDaemon prompt",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
  });

  test("updates model and thinking through Pi runtime commands", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.setModelResult = { provider: "openrouter", id: "model-a", name: "Model A" };

    await session.setModel("openrouter/model-a");
    await session.setThinkingOption("high");

    expect(fakeSession.setModelRequests).toEqual([{ provider: "openrouter", modelId: "model-a" }]);
    expect(fakeSession.setThinkingLevelRequests).toEqual(["high"]);
  });

  test("materializes image prompts as text hints for text-only Pi models", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.setModelResult = {
      provider: "openrouter",
      id: "openai/gpt-oss-20b:free",
      name: "OpenAI: gpt-oss-20b (free)",
      input: ["text"],
    };

    await session.setModel("openrouter/openai/gpt-oss-20b:free");
    await session.startTurn([
      { type: "text", text: "Describe this image." },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    let imagePath: string | undefined;
    try {
      expect(fakeSession.prompts).toHaveLength(1);
      const prompt = fakeSession.prompts[0]!;
      expect(prompt.imageCount).toBe(0);
      expect(prompt.message).toContain("Describe this image.");
      expect(prompt.message).not.toContain(ONE_BY_ONE_PNG_BASE64);
      imagePath = prompt.message.match(/\[Image available at: (.+)\]/)?.[1];
      expect(imagePath).toBeTypeOf("string");
      expect(imagePath).toMatch(
        /paseo-attachments(?:-[^\\/]+)?[\\/](?:[^\\/]+[\\/])?[0-9a-f]{64}\.png$/,
      );
      expect(existsSync(imagePath!)).toBe(true);
    } finally {
      if (imagePath) {
        rmSync(imagePath, { force: true });
      }
    }
  });

  test("materializes image prompts when Pi model capabilities are unknown", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();

    await session.startTurn([
      { type: "text", text: "Describe this image." },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    let imagePath: string | undefined;
    try {
      expect(fakeSession.prompts).toHaveLength(1);
      const prompt = fakeSession.prompts[0]!;
      expect(prompt.imageCount).toBe(0);
      expect(prompt.message).toContain("Describe this image.");
      imagePath = prompt.message.match(/\[Image available at: (.+)\]/)?.[1];
      expect(imagePath).toBeTypeOf("string");
      expect(existsSync(imagePath!)).toBe(true);
    } finally {
      if (imagePath) {
        rmSync(imagePath, { force: true });
      }
    }
  });

  test("forwards raw image prompts for vision-capable Pi models", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.setModelResult = {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT-4o",
      input: ["text", "image"],
    };

    await session.setModel("openai/gpt-4o");
    await session.startTurn([
      { type: "text", text: "Describe this image." },
      { type: "image", data: ONE_BY_ONE_PNG_BASE64, mimeType: "image/png" },
    ]);

    expect(fakeSession.prompts).toEqual([
      {
        message: "Describe this image.",
        imageCount: 1,
      },
    ]);
  });

  test("fails the active turn when the Pi process exits mid-turn", async () => {
    const { pi, session, events } = await createSession();

    await session.startTurn("hello");
    pi.latestSession().emit({ type: "process_exit", error: "Pi exited" });

    await expect(events.nextTurnFailure()).resolves.toMatchObject({
      error: "Pi exited",
    });
  });
});

describe("PiRpcAgentClient", () => {
  test("lists JSONL persisted sessions from configured provider params", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-sessions-"));
    const cwd = path.join(root, "workspace");
    const otherCwd = path.join(root, "other");
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260101_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-session-jsonl",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "first prompt" },
        }),
        JSON.stringify({
          type: "session_info",
          id: "info-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          name: "Imported Pi session",
        }),
        JSON.stringify({
          type: "message",
          id: "entry-2",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: { role: "user", content: [{ type: "text", text: "last prompt" }] },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(sessionsDir, "other.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "other", cwd: otherCwd })}\n`,
      "utf8",
    );
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      providerParams: { sessionDir: sessionsDir },
    });

    await expect(client.listImportableSessions({ cwd })).resolves.toEqual([
      {
        providerHandleId: sessionFile,
        cwd,
        title: "Imported Pi session",
        firstPromptPreview: "first prompt",
        lastPromptPreview: "last prompt",
        lastActivityAt: new Date("2026-01-01T00:00:03.000Z"),
      },
    ]);
  });

  test("lists JSONL persisted sessions from Pi's configured agent directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-default-sessions-"));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, ".pi", "agent");
    const sessionsDir = path.join(agentDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260102_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-default-session",
          timestamp: "2026-01-02T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-01-02T00:00:01.000Z",
          message: { role: "user", content: "default dir prompt" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      runtimeSettings: {
        env: {
          PI_CODING_AGENT_DIR: agentDir,
        },
      },
    });

    await expect(client.listImportableSessions({ cwd })).resolves.toMatchObject([
      {
        providerHandleId: sessionFile,
        cwd,
        title: "default dir prompt",
        firstPromptPreview: "default dir prompt",
        lastPromptPreview: "default dir prompt",
      },
    ]);
  });

  test("imports JSONL sessions with the recorded model and thinking level", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-import-config-"));
    const cwd = path.join(root, "workspace");
    const sessionsDir = path.join(root, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260103_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-import-session",
          timestamp: "2026-01-03T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          timestamp: "2026-01-03T00:00:01.000Z",
          message: { role: "user", content: "first prompt" },
        }),
        JSON.stringify({
          type: "model_change",
          id: "model-1",
          timestamp: "2026-01-03T00:00:02.000Z",
          provider: "openrouter",
          modelId: "anthropic/claude-sonnet-4.5",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          id: "thinking-1",
          timestamp: "2026-01-03T00:00:03.000Z",
          thinkingLevel: "high",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const pi = new FakePi();
    const client = new PiRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: pi,
      providerParams: { sessionDir: sessionsDir },
    });

    const imported = await client.importSession(
      { providerHandleId: sessionFile, cwd },
      { config: createConfig({ cwd }), storedConfig: createConfig({ cwd }) },
    );

    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--model",
      "openrouter/anthropic/claude-sonnet-4.5",
      "--thinking",
      "high",
      "--session",
      sessionFile,
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    expect(imported.config).toMatchObject({
      provider: "pi",
      cwd,
      model: "openrouter/anthropic/claude-sonnet-4.5",
      thinkingOptionId: "high",
    });
    expect(imported.persistence.metadata).toMatchObject({
      provider: "pi",
      cwd,
      model: "openrouter/anthropic/claude-sonnet-4.5",
      thinkingOptionId: "high",
    });
  });

  test("discovers models from a short-lived Pi session in the requested cwd", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const catalogPromise = client.fetchCatalog({
      scope: "workspace",
      cwd: "/workspace/with-extension",
      force: false,
    });
    pi.latestSession().models = [
      {
        provider: "openrouter",
        id: "google/gemini-2.5-flash-lite",
        name: "google/gemini-2.5-flash-lite",
        reasoning: true,
      },
    ];

    await expect(catalogPromise).resolves.toMatchObject({
      models: [
        {
          provider: "pi",
          id: "openrouter/google/gemini-2.5-flash-lite",
          label: "gemini-2.5-flash-lite",
          defaultThinkingOptionId: "medium",
        },
      ],
      modes: [],
    });
    expect(pi.recordedLaunches[0]).toMatchObject({ cwd: "/workspace/with-extension" });
  });

  test("lists no draft features without starting a Pi session", async () => {
    const pi = new FakePi();
    const client = createClient(pi);

    await expect(
      client.listFeatures(createConfig({ model: "openrouter/test/model" })),
    ).resolves.toEqual([]);

    expect(pi.recordedLaunches).toHaveLength(0);
  });

  test("maps extension, prompt, and skill commands to Paseo slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "review", description: "Review changes", source: "extension" },
      { name: "fix-tests", description: "Fix tests", source: "prompt" },
      { name: "skill:docs", description: "Read docs", source: "skill" },
    ];

    await expect(session.listCommands()).resolves.toEqual([
      {
        name: "compact",
        description: "Manually compact the session context",
        argumentHint: "[instructions]",
        kind: "command",
      },
      {
        name: "autocompact",
        description: "Toggle automatic context compaction",
        argumentHint: "[on|off|toggle]",
        kind: "command",
      },
      { name: "review", description: "Review changes", argumentHint: "", kind: "command" },
      { name: "fix-tests", description: "Fix tests", argumentHint: "", kind: "command" },
      { name: "skill:docs", description: "Read docs", argumentHint: "", kind: "skill" },
    ]);
  });

  test("lists Pi compact even when RPC get_commands omits built-in slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "review", description: "Review changes", source: "extension" },
    ];

    await expect(session.listCommands()).resolves.toContainEqual({
      name: "compact",
      description: "Manually compact the session context",
      argumentHint: "[instructions]",
      kind: "command",
    });
    await expect(session.listCommands()).resolves.toContainEqual({
      name: "autocompact",
      description: "Toggle automatic context compaction",
      argumentHint: "[on|off|toggle]",
      kind: "command",
    });
  });

  test("preserves known argument hints when RPC get_commands returns built-in slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "compact", description: "Compact from RPC", source: "extension" },
      { name: "autocompact", description: "Auto compact from RPC", source: "extension" },
    ];

    await expect(session.listCommands()).resolves.toEqual([
      {
        name: "compact",
        description: "Compact from RPC",
        argumentHint: "[instructions]",
        kind: "command",
      },
      {
        name: "autocompact",
        description: "Auto compact from RPC",
        argumentHint: "[on|off|toggle]",
        kind: "command",
      },
    ]);
  });

  test("executes Pi compact through RPC instead of prompt text", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/compact focus on tests");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.compactRequests).toEqual([{ customInstructions: "focus on tests" }]);
    expect(fakeSession.prompts).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      },
    ]);
  });

  test("closes Pi compact loading marker when RPC rejects after compaction starts", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.emitCompactEnd = false;
    fakeSession.compactError = new Error("summarizer failed");
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/compact");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "loading", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "[Error] Failed to compact context: summarizer failed",
        },
      },
    ]);
  });

  test("executes Pi autocompact through RPC instead of prompt text", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact off");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([false]);
    expect(fakeSession.prompts).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "Auto-compaction disabled." },
      },
    ]);
  });

  test("rejects unknown Pi autocompact mode instead of toggling", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact banana");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "[Error] Usage: /autocompact [on|off|toggle]",
        },
      },
    ]);
  });

  test("toggles Pi autocompact through current RPC state", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    fakeSession.state.autoCompactionEnabled = false;
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([true]);
    expect(events).toContainEqual({
      type: "timeline",
      provider: "pi",
      item: { type: "assistant_message", text: "Auto-compaction enabled." },
    });
  });

  test("rejects Pi autocompact toggle when current RPC state is unavailable", async () => {
    const { pi, session } = await createSession();
    const fakeSession = pi.latestSession();
    delete fakeSession.state.autoCompactionEnabled;
    const handler = (session as AgentSession).tryHandleOutOfBand?.("/autocompact");
    const events: AgentStreamEvent[] = [];

    expect(handler).not.toBeNull();
    await handler?.run({ emit: (event) => events.push(event) });

    expect(fakeSession.setAutoCompactionRequests).toEqual([]);
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "[Error] Auto-compaction state is unavailable. Use /autocompact on or /autocompact off.",
        },
      },
    ]);
  });

  test("rewinds conversation through the Pi tree navigation bridge", async () => {
    const { pi, session, events } = await createSession();
    pi.latestSession().capturedUserEntries = [
      { id: "entry-1", parentId: null, text: "first prompt" },
      { id: "entry-3", parentId: "entry-2", text: "second prompt" },
    ];

    await session.startTurn("first prompt");
    pi.latestSession().finishTurn({ role: "assistant", content: [] });
    await events.nextTurnCompletion();

    await session.revertConversation?.({ messageId: "entry-1" });

    expect(rewindCapabilities(session.capabilities)).toEqual({
      supportsRewindConversation: true,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    });
    expect(pi.latestSession().treeNavigationRequests).toEqual(["entry-1"]);
  });

  test("injects MCP servers without replacing the Pi global MCP config", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "paseo-pi-agent-"));
    onTestFinished(() => rmSync(agentDir, { recursive: true, force: true }));
    writeFileSync(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        settings: { toolPrefix: "none", disableProxyTool: true },
        "mcp-servers": {
          "brave-search": {
            url: "https://example.com/mcp/brave",
            directTools: ["brave_llm_context"],
          },
        },
      }),
    );
    const pi = new FakePi();
    pi.queueCommands([
      {
        name: "mcp",
        description: "Show MCP server status",
        source: "extension",
        sourceInfo: { source: "npm:pi-mcp-adapter" },
      },
    ]);
    const client = createClient(pi);

    const session = await client.createSession(
      createConfig({
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          },
          localSecret: {
            type: "stdio",
            command: "node",
            args: ["secret-server.js"],
            env: { SECRET_NUMBER: "314159" },
          },
        },
      }),
      { env: { PI_CODING_AGENT_DIR: agentDir } },
    );

    expect(pi.recordedLaunches).toHaveLength(2);
    expect(pi.recordedLaunches[0]).toMatchObject({
      cwd: "/tmp/paseo-pi-rpc-test",
      argv: ["pi", "--mode", "rpc"],
    });
    const actualLaunch = pi.recordedLaunches[1]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--mcp-config",
      actualLaunch.mcpConfigPath,
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    expect(session.capabilities.supportsMcpServers).toBe(true);

    const configPath = actualLaunch.mcpConfigPath;
    expect(configPath).toEqual(expect.any(String));
    const injectedConfig = JSON.parse(readUtf8File(configPath!)) as {
      mcpServers: Record<string, unknown>;
    };
    expect(injectedConfig).toEqual({
      settings: { toolPrefix: "none", disableProxyTool: true },
      mcpServers: {
        "brave-search": {
          url: "https://example.com/mcp/brave",
          directTools: ["brave_llm_context"],
        },
        paseo: {
          url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          auth: false,
          oauth: false,
        },
        localSecret: {
          command: "node",
          args: ["secret-server.js"],
          env: { SECRET_NUMBER: "314159" },
        },
      },
    });

    await session.close();
    expect(existsSync(configPath!)).toBe(false);
  });

  test("reports the path of a malformed Pi global MCP config", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "paseo-pi-agent-"));
    onTestFinished(() => rmSync(agentDir, { recursive: true, force: true }));
    const configPath = path.join(agentDir, "mcp.json");
    writeFileSync(configPath, "{ invalid");
    const pi = new FakePi();
    pi.queueCommands([{ name: "mcp", source: "extension" }]);
    const client = createClient(pi);

    await expect(
      client.createSession(
        createConfig({
          mcpServers: {
            paseo: { type: "http", url: "http://127.0.0.1:6767/mcp/agents" },
          },
        }),
        { env: { PI_CODING_AGENT_DIR: agentDir } },
      ),
    ).rejects.toThrow(`Failed to parse Pi MCP config: ${configPath}`);
  });

  test("does not pass MCP config when pi-mcp-adapter is not loaded", async () => {
    const pi = new FakePi();
    pi.queueCommands([]);
    const client = createClient(pi);

    const session = await client.createSession(
      createConfig({
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
          },
        },
      }),
    );

    expect(pi.recordedLaunches).toHaveLength(2);
    const actualLaunch = pi.recordedLaunches[1]!;
    expect(actualLaunch.extensionPaths).toHaveLength(1);
    expect(actualLaunch.argv).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--thinking",
      "medium",
      "--extension",
      actualLaunch.extensionPaths[0],
    ]);
    expect(actualLaunch.mcpConfigPath).toBeUndefined();
    expect(session.capabilities.supportsMcpServers).toBe(false);
  });
});

describe("transformPiModels", () => {
  test("normalizes labels that include the upstream provider prefix", () => {
    expect(
      transformPiModels([
        {
          provider: "pi",
          id: "openrouter/google/gemini-2.5-flash-lite",
          label: "openrouter/google/gemini_2.5 flash lite",
        },
        {
          provider: "pi",
          id: "openrouter/openai/gpt-5.5",
          label: "openrouter/OpenAI: GPT-5.5",
        },
      ]),
    ).toEqual([
      {
        provider: "pi",
        id: "openrouter/google/gemini-2.5-flash-lite",
        label: "gemini 2.5 flash lite",
        description: "openrouter/google/gemini_2.5 flash lite",
      },
      {
        provider: "pi",
        id: "openrouter/openai/gpt-5.5",
        label: "GPT-5.5",
        description: "openrouter/OpenAI: GPT-5.5",
      },
    ]);
  });
});
