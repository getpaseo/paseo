import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { PiRpcAgentClient, PiRpcAgentSession, transformPiModels } from "./agent.js";
import { FakePi } from "./test-utils/fake-pi.js";

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
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
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
      { type: "assistant_message", text: "hello" },
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
    );

    expect(pi.recordedLaunches).toHaveLength(1);
    const actualLaunch = pi.recordedLaunches[0]!;
    expect(actualLaunch).toMatchObject({
      cwd: "/workspace/project",
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
  test("lists models from a short-lived Pi session in the requested cwd", async () => {
    const pi = new FakePi();
    const client = createClient(pi);
    const modelsPromise = client.listModels({ cwd: "/workspace/with-extension", force: false });
    pi.latestSession().models = [
      {
        provider: "openrouter",
        id: "google/gemini-2.5-flash-lite",
        name: "google/gemini-2.5-flash-lite",
        reasoning: true,
      },
    ];

    await expect(modelsPromise).resolves.toMatchObject([
      {
        provider: "pi",
        id: "openrouter/google/gemini-2.5-flash-lite",
        label: "gemini-2.5-flash-lite",
        defaultThinkingOptionId: "medium",
      },
    ]);
    expect(pi.recordedLaunches[0]).toMatchObject({ cwd: "/workspace/with-extension" });
  });

  test("maps extension, prompt, and skill commands to Paseo slash commands", async () => {
    const { pi, session } = await createSession();
    pi.latestSession().commands = [
      { name: "review", description: "Review changes", source: "extension" },
      { name: "fix-tests", description: "Fix tests", source: "prompt" },
      { name: "skill:docs", description: "Read docs", source: "skill" },
    ];

    await expect(session.listCommands()).resolves.toEqual([
      { name: "review", description: "Review changes", argumentHint: "" },
      { name: "fix-tests", description: "Fix tests", argumentHint: "" },
      { name: "skill:docs", description: "Read docs", argumentHint: "" },
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

  test("injects MCP servers through pi-mcp-adapter when the extension is loaded", async () => {
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
      mcpServers: {
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
      ]),
    ).toEqual([
      {
        provider: "pi",
        id: "openrouter/google/gemini-2.5-flash-lite",
        label: "gemini 2.5 flash lite",
        description: "openrouter/google/gemini_2.5 flash lite",
      },
    ]);
  });
});
