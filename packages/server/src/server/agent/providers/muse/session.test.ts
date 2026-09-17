import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import type {
  MuseHostConnection,
  MuseHostNotification,
  MuseHostServerRequest,
} from "./host.js";
import { isMissingRunError, MuseAgentSession } from "./session.js";

function createHarness(options?: {
  systemPrefix?: string;
  modelId?: string | null;
  thinkingOptionId?: string | null;
  config?: AgentSessionConfig;
}) {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const routes = new Map<string, (params: Record<string, unknown>) => unknown>();
  const events: AgentStreamEvent[] = [];
  let notifHandler: ((notification: MuseHostNotification) => void) | undefined;
  let requestHandler:
    | ((request: MuseHostServerRequest) => Promise<Record<string, unknown>>)
    | undefined;
  let exitHandler: ((exit: { code: number | null; signal: string | null }) => void) | undefined;
  const host: MuseHostConnection = {
    initializeResult: {},
    fingerprintWarning: undefined,
    command: vi.fn(async (method: string, params: Record<string, unknown>) => {
      commands.push({ method, params });
      const route = routes.get(method);
      if (!route) {
        throw new Error(`unexpected command ${method}`);
      }
      return route(params);
    }),
    modelList: vi.fn(async () => ({ models: [] })),
    onNotification: vi.fn((handler) => {
      notifHandler = handler;
    }),
    onServerRequest: vi.fn((handler) => {
      requestHandler = handler;
    }),
    onExit: vi.fn((handler) => {
      exitHandler = handler;
    }),
    close: vi.fn(async () => {}),
  };
  const session = new MuseAgentSession({
    host,
    sessionId: "session-1",
    config: options?.config ?? { provider: "muse", cwd: "/tmp/muse" },
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    modelId: options?.modelId ?? null,
    thinkingOptionId: options?.thinkingOptionId ?? null,
    modeId: "allowAll",
    systemPrefix: options?.systemPrefix,
    logger: createTestLogger(),
    interruptTimeoutMs: 50,
  });
  session.subscribe((event) => events.push(event));
  return {
    host,
    session,
    commands,
    routes,
    events,
    emit: (notification: MuseHostNotification) => notifHandler?.(notification),
    request: (request: MuseHostServerRequest) => requestHandler?.(request),
    exit: (exit: { code: number | null; signal: string | null }) => exitHandler?.(exit),
  };
}

function acceptTurn(turnId = "turn-1") {
  return { status: "accepted", commandId: turnId, turnId, disposition: "started" };
}

function mspError(message: string, kind: string) {
  return Object.assign(new Error(message), { kind });
}

function approvalParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId: "approval-1",
    sessionId: "session-1",
    currentRequirementId: "req-1",
    toolName: "shell",
    rawArgs: JSON.stringify({ command: "ls" }),
    subject: { kind: "shell", stages: [{ argv: ["ls"] }] },
    availableChoices: [
      {
        choiceId: "allow-once",
        decision: "approved",
        label: "Allow once",
        scope: "once",
        acceptsFeedback: false,
      },
      {
        choiceId: "deny",
        decision: "denied",
        label: "Deny",
        scope: "once",
        acceptsFeedback: true,
      },
    ],
    ...overrides,
  };
}

function userInputParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userInputId: "input-1",
    sessionId: "session-1",
    toolName: "askUser",
    questions: [
      {
        id: "q1",
        header: "Target",
        question: "Which target?",
        selection: { mode: "single" },
        options: [{ label: "a" }, { label: "b" }],
      },
    ],
    ...overrides,
  };
}

describe("MuseAgentSession", () => {
  test("startTurn submits parts and returns the admitted turn id", async () => {
    const { session, commands, routes } = createHarness();
    routes.set("turn/start", () => acceptTurn());

    const result = await session.startTurn("hello", { clientMessageId: "client-1" });

    expect(result).toEqual({ turnId: "turn-1" });
    expect(commands).toEqual([
      {
        method: "turn/start",
        params: {
          sessionId: "session-1",
          input: [{ type: "text", text: "hello" }],
          displayText: "hello",
          ifBusy: "queue",
        },
      },
    ]);
    await expect(session.startTurn("again")).rejects.toThrow("already active");
  });

  test("delivers the system prefix with the first turn only", async () => {
    const { session, commands, routes, emit } = createHarness({ systemPrefix: "Be terse." });
    routes.set("turn/start", (params) => {
      const input = params["input"] as Array<{ text?: string }>;
      return acceptTurn(input[0]?.text?.includes("Be terse.") ? "turn-1" : "turn-2");
    });

    await session.startTurn("first");
    emit({ method: "turn/completed", params: { turnId: "turn-1", terminal: "completed" } });
    await session.startTurn("second");

    expect(commands[0]?.params["input"]).toEqual([
      { type: "text", text: "Be terse." },
      { type: "text", text: "first" },
    ]);
    expect(commands[0]?.params["displayText"]).toBe("first");
    expect(commands[1]?.params["input"]).toEqual([{ type: "text", text: "second" }]);
  });

  test("run resolves with streamed text and echoes the user row", async () => {
    const { session, routes, commands, emit, events } = createHarness();
    routes.set("turn/start", () => acceptTurn());

    const pending = session.run("hello", { clientMessageId: "client-1" });
    await vi.waitFor(() => {
      expect(commands).toHaveLength(1);
    });
    emit({ method: "turn/started", params: { turnId: "turn-1" } });
    emit({
      method: "item/completed",
      params: {
        item: {
          itemId: "u1",
          revision: 1,
          kind: "userMessage",
          turnId: "turn-1",
          commandId: "turn-1",
          status: "completed",
          text: "hello",
        },
      },
    });
    emit({
      method: "item/started",
      params: {
        item: {
          itemId: "a1",
          revision: 1,
          kind: "agentMessage",
          turnId: "turn-1",
          status: "inProgress",
        },
      },
    });
    emit({ method: "item/delta", params: { itemId: "a1", delta: "Hi", field: "text" } });
    emit({
      method: "item/completed",
      params: {
        item: {
          itemId: "a1",
          revision: 2,
          kind: "agentMessage",
          turnId: "turn-1",
          status: "completed",
          text: "Hi",
        },
      },
    });
    emit({ method: "turn/completed", params: { turnId: "turn-1", terminal: "completed" } });

    const result = await pending;
    expect(result.finalText).toBe("Hi");
    expect(events.map((event) => event.type)).toEqual([
      "turn_started",
      "timeline",
      "timeline",
      "turn_completed",
    ]);
    const echo = events[1];
    expect(echo).toMatchObject({
      type: "timeline",
      item: { type: "user_message", messageId: "client-1", clientMessageId: "client-1" },
    });
  });

  test("surfaces failed and canceled terminals", async () => {
    const { session, routes, commands, emit, events } = createHarness();
    routes.set("turn/start", () => acceptTurn());

    const failed = session.run("boom");
    await vi.waitFor(() => {
      expect(commands).toHaveLength(1);
    });
    emit({
      method: "turn/completed",
      params: { turnId: "turn-1", terminal: "failed", reason: "bad" },
    });
    await expect(failed).rejects.toThrow("bad");

    routes.set("turn/start", () => acceptTurn("turn-2"));
    const canceled = session.run("stop");
    await vi.waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    emit({ method: "turn/completed", params: { turnId: "turn-2", terminal: "cancelled" } });
    await expect(canceled).resolves.toMatchObject({ finalText: "" });
    expect(events.at(-1)).toMatchObject({ type: "turn_canceled", turnId: "turn-2" });
  });

  test("interrupt cancels the active turn and waits for its terminal", async () => {
    const { session, routes, commands, emit } = createHarness();
    routes.set("turn/start", () => acceptTurn());
    routes.set("turn/cancel", () => ({ status: "accepted" }));

    await session.startTurn("slow");
    const pending = session.interrupt();
    emit({ method: "turn/completed", params: { turnId: "turn-1", terminal: "cancelled" } });
    await pending;

    expect(commands.map((command) => command.method)).toEqual(["turn/start", "turn/cancel"]);
    // The next turn is admitted once the canceled turn settles.
    await session.startTurn("next");
  });

  test("interrupt tolerates an already-settled turn", async () => {
    const { session, routes, emit } = createHarness();
    routes.set("turn/start", () => acceptTurn());
    routes.set("turn/cancel", () => {
      throw Object.assign(new Error("turn/cancel rejected: missing_run"), {
        code: -32030,
        kind: "commandRejected",
      });
    });

    await session.startTurn("fast");
    const pending = session.interrupt();
    emit({ method: "turn/completed", params: { turnId: "turn-1", terminal: "completed" } });
    await pending;
  });

  test("interrupt is a no-op without an active turn", async () => {
    const { session, commands } = createHarness();

    await session.interrupt();

    expect(commands).toEqual([]);
  });

  test("host exit fails the active turn", async () => {
    const { session, routes, commands, events, exit } = createHarness();
    routes.set("turn/start", () => acceptTurn());

    const pending = session.run("doomed");
    await vi.waitFor(() => {
      expect(commands).toHaveLength(1);
    });
    exit({ code: 1, signal: null });

    await expect(pending).rejects.toThrow("host exited");
    expect(events.at(-1)).toMatchObject({ type: "turn_failed", turnId: "turn-1" });
  });

  test("streamHistory hydrates inline items and unknown rows are skipped", async () => {
    const { session, routes } = createHarness();
    routes.set("session/resume", () => ({
      history: {
        mode: "inline",
        items: [
          {
            itemId: "u1",
            revision: 1,
            kind: "userMessage",
            turnId: "t0",
            status: "completed",
            text: "past",
          },
          {
            itemId: "a1",
            revision: 1,
            kind: "agentMessage",
            turnId: "t0",
            status: "completed",
            text: "reply",
          },
        ],
      },
    }));

    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["timeline", "timeline"]);
    expect(events[0]).toMatchObject({
      item: { type: "user_message", text: "past", messageId: "u1" },
    });
    expect(events[0]).not.toHaveProperty("clientMessageId");
  });

  test("streamHistory replays subagent track events alongside the timeline", async () => {
    const { session, routes } = createHarness();
    routes.set("session/resume", () => ({
      history: {
        mode: "inline",
        items: [
          {
            itemId: "u1",
            revision: 1,
            kind: "userMessage",
            turnId: "t0",
            status: "completed",
            text: "past",
          },
          {
            itemId: "sub-1",
            revision: 2,
            kind: "subagent",
            turnId: "t0",
            status: "completed",
            role: "researcher",
            objective: "Find the bug",
            subagentId: "child-1",
            result: { summary: "Found it" },
          },
        ],
      },
    }));

    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "timeline",
      "provider_subagent",
      "provider_subagent",
    ]);
    expect(events[1]).toMatchObject({
      provider: "muse",
      event: { type: "upsert", id: "child-1", status: "completed" },
    });
    expect(events[2]).toMatchObject({
      event: { type: "timeline", id: "child-1", item: { text: "Found it" } },
    });
  });

  test("tracks model and mode changes", async () => {
    const { session, emit, events } = createHarness();

    emit({ method: "session/modelChanged", params: { modelId: "muse-spark-1.3" } });
    emit({ method: "session/approvalModeChanged", params: { mode: "denyUnmatched" } });

    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "muse-spark-1.3",
      modeId: "denyUnmatched",
    });
    expect(events.map((event) => event.type)).toEqual(["model_changed", "mode_changed"]);
  });

  test("close releases the host and rejects new turns", async () => {
    const { session, host } = createHarness();

    await session.close();
    await session.close();

    expect(host.close).toHaveBeenCalledTimes(1);
    await expect(session.startTurn("late")).rejects.toThrow("closed");
  });

  test("surfaces server approval requests and decides them", async () => {
    const { session, commands, routes, events, request } = createHarness();
    routes.set("approval/decide", () => ({}));

    await request({
      requestId: 1,
      method: "approval/request",
      params: approvalParams(),
    });

    expect(session.getPendingPermissions()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "permission_requested",
      provider: "muse",
      request: { id: "approval-1", kind: "tool" },
    });

    await session.respondToPermission("approval-1", { behavior: "allow" });

    expect(commands).toEqual([
      {
        method: "approval/decide",
        params: {
          sessionId: "session-1",
          approvalId: "approval-1",
          requirementId: "req-1",
          choiceId: "allow-once",
        },
      },
    ]);
    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "permission_resolved",
      provider: "muse",
      requestId: "approval-1",
      resolution: { behavior: "allow" },
    });
  });

  test("rejects responses for unknown permission requests", async () => {
    const { session } = createHarness();

    await expect(session.respondToPermission("missing", { behavior: "allow" })).rejects.toThrow(
      "Unknown Muse permission request: missing",
    );
  });

  test("sends deny feedback with approval decisions", async () => {
    const { session, commands, routes, request } = createHarness();
    routes.set("approval/decide", () => ({}));
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });

    await session.respondToPermission("approval-1", {
      behavior: "deny",
      message: "too risky",
    });

    expect(commands).toEqual([
      {
        method: "approval/decide",
        params: {
          sessionId: "session-1",
          approvalId: "approval-1",
          requirementId: "req-1",
          choiceId: "deny",
          feedback: "too risky",
        },
      },
    ]);
  });

  test("tolerates already-resolved approvals", async () => {
    const { session, routes, events, request } = createHarness();
    routes.set("approval/decide", () => {
      throw mspError("already resolved", "approvalAlreadyResolved");
    });
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });

    await session.respondToPermission("approval-1", { behavior: "allow" });

    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "permission_resolved",
      requestId: "approval-1",
    });
  });

  test("refreshes stale approval requirements and retries", async () => {
    const { session, commands, routes, request } = createHarness();
    let attempts = 0;
    routes.set("approval/decide", () => {
      attempts += 1;
      if (attempts === 1) {
        throw mspError("stale requirement", "approvalRequirementStale");
      }
      return {};
    });
    routes.set("approval/listPending", () => ({
      approvals: [approvalParams({ currentRequirementId: "req-2" })],
    }));
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });

    await session.respondToPermission("approval-1", { behavior: "allow" });

    expect(commands.map((command) => command.method)).toEqual([
      "approval/decide",
      "approval/listPending",
      "approval/decide",
    ]);
    expect(commands[2]?.params).toMatchObject({
      approvalId: "approval-1",
      requirementId: "req-2",
      choiceId: "allow-once",
    });
  });

  test("reports approvals that vanish mid-decision", async () => {
    const { session, routes, request } = createHarness();
    routes.set("approval/decide", () => {
      throw mspError("gone", "approvalNotFound");
    });
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });

    await expect(session.respondToPermission("approval-1", { behavior: "allow" })).rejects.toThrow(
      "Muse approval is no longer pending",
    );
    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  test("asks for review when approval choices change", async () => {
    const { session, commands, routes, request } = createHarness();
    routes.set("approval/decide", () => {
      throw mspError("choices changed", "approvalChoiceInvalid");
    });
    routes.set("approval/listPending", () => ({
      approvals: [approvalParams({ currentRequirementId: "req-2" })],
    }));
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });

    await expect(session.respondToPermission("approval-1", { behavior: "allow" })).rejects.toThrow(
      "Muse approval choices changed; review the updated request",
    );
    expect(commands.map((command) => command.method)).toEqual([
      "approval/decide",
      "approval/listPending",
    ]);
    expect(session.getPendingPermissions()).toHaveLength(1);
  });

  test("answers server user-input requests", async () => {
    const { session, commands, routes, events, request } = createHarness();
    routes.set("userInput/answer", () => ({}));
    await request({ requestId: 2, method: "userInput/request", params: userInputParams() });

    expect(session.getPendingPermissions()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "permission_requested",
      request: { id: "input-1", kind: "question" },
    });

    await session.respondToPermission("input-1", {
      behavior: "allow",
      updatedInput: { answers: { Target: "b" } },
    });

    expect(commands).toEqual([
      {
        method: "userInput/answer",
        params: {
          sessionId: "session-1",
          userInputId: "input-1",
          answers: [{ questionId: "q1", selectedLabel: "b" }],
        },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "permission_resolved",
      requestId: "input-1",
    });
  });

  test("cancels user input on deny", async () => {
    const { session, commands, routes, request } = createHarness();
    routes.set("userInput/cancel", () => ({}));
    await request({ requestId: 2, method: "userInput/request", params: userInputParams() });

    await session.respondToPermission("input-1", {
      behavior: "deny",
      message: "stop asking",
    });

    expect(commands).toEqual([
      {
        method: "userInput/cancel",
        params: { sessionId: "session-1", userInputId: "input-1", reason: "stop asking" },
      },
    ]);
  });

  test("tolerates settled or missing user input", async () => {
    const settled = createHarness();
    settled.routes.set("userInput/answer", () => {
      throw mspError("settled", "userInputAlreadySettled");
    });
    await settled.request({ requestId: 2, method: "userInput/request", params: userInputParams() });
    await settled.session.respondToPermission("input-1", { behavior: "allow" });
    expect(settled.session.getPendingPermissions()).toHaveLength(0);

    const missing = createHarness();
    missing.routes.set("userInput/answer", () => {
      throw mspError("gone", "userInputNotFound");
    });
    await missing.request({
      requestId: 2,
      method: "userInput/request",
      params: userInputParams(),
    });
    await expect(
      missing.session.respondToPermission("input-1", { behavior: "allow" }),
    ).rejects.toThrow("Muse question is no longer pending");
    expect(missing.session.getPendingPermissions()).toHaveLength(0);
  });

  test("clears pending requests on settled notifications", async () => {
    const { session, emit, request } = createHarness();
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });
    await request({ requestId: 2, method: "userInput/request", params: userInputParams() });
    expect(session.getPendingPermissions()).toHaveLength(2);

    emit({ method: "approval/resolved", params: { approvalId: "approval-1" } });
    emit({ method: "userInput/settled", params: { userInputId: "input-1" } });

    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  test("setMode updates the host approval mode", async () => {
    const { session, commands, routes, events } = createHarness();
    routes.set("session/setApprovalMode", () => ({}));

    await session.setMode("denyUnmatched");

    expect(commands).toEqual([
      {
        method: "session/setApprovalMode",
        params: { sessionId: "session-1", approvalMode: "denyUnmatched" },
      },
    ]);
    await expect(session.getCurrentMode()).resolves.toBe("denyUnmatched");
    expect(events.at(-1)).toMatchObject({
      type: "mode_changed",
      provider: "muse",
      currentModeId: "denyUnmatched",
    });
    await expect(session.setMode("bogus")).rejects.toThrow("Unknown Muse approval mode: bogus");
  });

  test("setModel switches the host model and restores the initial model", async () => {
    const { session, commands, routes, events } = createHarness({ modelId: "muse-spark-1.2" });
    routes.set("session/setModel", () => ({}));

    await session.setModel("muse-spark-1.3");
    await session.setModel(null);

    expect(commands).toEqual([
      {
        method: "session/setModel",
        params: { sessionId: "session-1", model: { modelId: "muse-spark-1.3" } },
      },
      {
        method: "session/setModel",
        params: { sessionId: "session-1", model: { modelId: "muse-spark-1.2" } },
      },
    ]);
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      model: "muse-spark-1.2",
    });
    expect(events.at(-1)).toMatchObject({ type: "model_changed", provider: "muse" });
  });

  test("setModel without a target is a no-op", async () => {
    const { session, commands } = createHarness();

    await session.setModel(null);

    expect(commands).toEqual([]);
  });

  test("setThinkingOption applies reasoning effort with a default", async () => {
    const { session, commands, routes } = createHarness();
    routes.set("session/setReasoningEffort", () => ({}));

    await session.setThinkingOption("low");
    await session.setThinkingOption(null);
    await session.setThinkingOption("bogus");

    expect(commands.map((command) => command.params["reasoningEffort"])).toEqual([
      "low",
      "high",
      "high",
    ]);
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      thinkingOptionId: "high",
    });
  });

  test("steerActiveTurn requires the expected turn", async () => {
    const { session, commands, routes } = createHarness();
    routes.set("turn/start", () => acceptTurn());
    routes.set("turn/steer", () => ({}));

    await expect(session.steerActiveTurn("early", { expectedTurnId: "turn-1" })).resolves.toEqual({
      status: "unavailable",
    });

    await session.startTurn("hello");
    await expect(session.steerActiveTurn("stale", { expectedTurnId: "turn-9" })).resolves.toEqual({
      status: "unavailable",
    });
    await expect(session.steerActiveTurn("more", { expectedTurnId: "turn-1" })).resolves.toEqual({
      status: "accepted",
    });

    expect(commands.map((command) => command.method)).toEqual(["turn/start", "turn/steer"]);
    expect(commands[1]?.params).toEqual({
      sessionId: "session-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "more" }],
    });
  });

  test("revertConversation forks through the previous turn and rebinds", async () => {
    const { session, commands, routes, request } = createHarness({
      modelId: "muse-spark-1.2",
    });
    routes.set("session/read", () => ({
      history: {
        mode: "inline",
        items: [
          {
            itemId: "u1",
            revision: 1,
            kind: "userMessage",
            turnId: "turn-1",
            status: "completed",
            text: "first",
          },
          {
            itemId: "a1",
            revision: 1,
            kind: "agentMessage",
            turnId: "turn-1",
            status: "completed",
            text: "reply",
          },
          {
            itemId: "u2",
            revision: 1,
            kind: "userMessage",
            turnId: "turn-2",
            status: "completed",
            text: "second",
          },
        ],
      },
    }));
    routes.set("session/fork", () => ({
      session: {
        sessionId: "session-2",
        modelId: "muse-spark-1.2",
        approvalMode: { mode: "allowAll" },
      },
      history: { mode: "none" },
    }));
    routes.set("turn/start", () => acceptTurn());
    await request({ requestId: 1, method: "approval/request", params: approvalParams() });
    expect(session.getPendingPermissions()).toHaveLength(1);

    await session.revertConversation({ messageId: "u2" });

    expect(commands.map((command) => command.method)).toEqual(["session/read", "session/fork"]);
    expect(commands[1]?.params).toEqual({
      sessionId: "session-1",
      cutPoint: { lastTurnId: "turn-1" },
      excludeItems: true,
    });
    expect(session.id).toBe("session-2");
    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(session.describePersistence()).toMatchObject({
      sessionId: "session-2",
      nativeHandle: "session-2",
    });

    await session.startTurn("after rewind");
    expect(commands[2]?.params["sessionId"]).toBe("session-2");
  });

  test("revertConversation to the first turn starts a fresh session", async () => {
    const { session, commands, routes } = createHarness({
      modelId: "muse-spark-1.2",
      thinkingOptionId: "low",
      config: {
        provider: "muse",
        cwd: "/tmp/muse",
        systemPrompt: "Be terse.",
        mcpServers: {
          paseo: { type: "http", url: "http://127.0.0.1:1/mcp/agents" },
        },
      },
    });
    routes.set("session/read", () => ({
      history: {
        mode: "inline",
        items: [
          {
            itemId: "u1",
            revision: 1,
            kind: "userMessage",
            turnId: "turn-1",
            status: "completed",
            text: "first",
          },
        ],
      },
    }));
    routes.set("session/start", () => ({
      session: {
        sessionId: "session-9",
        modelId: "muse-spark-1.2",
        approvalMode: { mode: "allowAll" },
      },
    }));
    routes.set("session/setReasoningEffort", () => ({}));
    routes.set("turn/start", () => acceptTurn());

    await session.revertConversation({ messageId: "u1" });

    expect(commands.map((command) => command.method)).toEqual([
      "session/read",
      "session/start",
      "session/setReasoningEffort",
    ]);
    expect(commands[1]?.params).toEqual({
      workspaceRoot: "/tmp/muse",
      approvalMode: "allowAll",
      modelId: "muse-spark-1.2",
      config: {
        mcpServers: {
          paseo: { transport: "streamableHttp", url: "http://127.0.0.1:1/mcp/agents" },
        },
      },
    });
    expect(commands[2]?.params).toEqual({
      sessionId: "session-9",
      reasoningEffort: "low",
    });
    expect(session.id).toBe("session-9");

    await session.startTurn("fresh");
    expect(commands[3]?.params["input"]).toEqual([
      { type: "text", text: "Be terse." },
      { type: "text", text: "fresh" },
    ]);
  });

  test("revertConversation rejects active turns and unknown targets", async () => {
    const busy = createHarness();
    busy.routes.set("turn/start", () => acceptTurn());
    await busy.session.startTurn("hello");
    await expect(busy.session.revertConversation({ messageId: "u1" })).rejects.toThrow(
      "while a turn is active",
    );

    const missing = createHarness();
    missing.routes.set("session/read", () => ({
      history: {
        mode: "inline",
        items: [
          {
            itemId: "u1",
            revision: 1,
            kind: "userMessage",
            turnId: "turn-1",
            status: "completed",
            text: "first",
          },
        ],
      },
    }));
    await expect(missing.session.revertConversation({ messageId: "nope" })).rejects.toThrow(
      "was not found in history",
    );

    const unavailable = createHarness();
    unavailable.routes.set("session/read", () => ({ history: { mode: "none" } }));
    await expect(unavailable.session.revertConversation({ messageId: "u1" })).rejects.toThrow(
      "Muse history is not available for rewind",
    );

    const closed = createHarness();
    await closed.session.close();
    await expect(closed.session.revertConversation({ messageId: "u1" })).rejects.toThrow(
      "Muse session is closed",
    );
  });

  test("revertConversation reports invalid fork boundaries", async () => {
    const { session, routes } = createHarness();
    routes.set("session/read", () => ({
      history: {
        mode: "inline",
        items: [
          {
            itemId: "u1",
            revision: 1,
            kind: "userMessage",
            turnId: "turn-1",
            status: "completed",
            text: "first",
          },
          {
            itemId: "u2",
            revision: 1,
            kind: "userMessage",
            turnId: "turn-2",
            status: "completed",
            text: "second",
          },
        ],
      },
    }));
    routes.set("session/fork", () => {
      throw mspError("bad boundary", "forkBoundaryInvalid");
    });

    await expect(session.revertConversation({ messageId: "u2" })).rejects.toThrow(
      "is not a completed-turn boundary",
    );
    expect(session.id).toBe("session-1");
  });

  test("steerActiveTurn maps command rejections to unavailable", async () => {
    const { session, routes } = createHarness();
    routes.set("turn/start", () => acceptTurn());
    routes.set("turn/steer", () => {
      throw mspError("busy", "commandRejected");
    });

    await session.startTurn("hello");

    await expect(session.steerActiveTurn("more", { expectedTurnId: "turn-1" })).resolves.toEqual({
      status: "unavailable",
    });

    routes.set("turn/steer", () => {
      throw new Error("boom");
    });
    await expect(session.steerActiveTurn("more", { expectedTurnId: "turn-1" })).rejects.toThrow(
      "boom",
    );
  });
});

describe("isMissingRunError", () => {
  test("matches only command rejections for a missing run", () => {
    expect(
      isMissingRunError(
        Object.assign(new Error("turn/cancel rejected: missing_run"), {
          kind: "commandRejected",
        }),
      ),
    ).toBe(true);
    expect(isMissingRunError(new Error("missing_run"))).toBe(false);
    expect(isMissingRunError(null)).toBe(false);
  });
});
