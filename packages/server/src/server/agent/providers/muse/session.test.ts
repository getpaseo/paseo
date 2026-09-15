import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { MuseHostConnection, MuseHostNotification } from "./host.js";
import { isMissingRunError, MuseAgentSession } from "./session.js";

function createHarness(options?: { systemPrefix?: string }) {
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  const routes = new Map<string, (params: Record<string, unknown>) => unknown>();
  const events: AgentStreamEvent[] = [];
  let notifHandler: ((notification: MuseHostNotification) => void) | undefined;
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
    onServerRequest: vi.fn(),
    onExit: vi.fn((handler) => {
      exitHandler = handler;
    }),
    close: vi.fn(async () => {}),
  };
  const session = new MuseAgentSession({
    host,
    sessionId: "session-1",
    config: { provider: "muse", cwd: "/tmp/muse" },
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    modelId: null,
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
    exit: (exit: { code: number | null; signal: string | null }) => exitHandler?.(exit),
  };
}

function acceptTurn(turnId = "turn-1") {
  return { status: "accepted", commandId: turnId, turnId, disposition: "started" };
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
