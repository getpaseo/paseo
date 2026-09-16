import { describe, expect, test } from "vitest";

import type { AgentStreamEvent, AgentUsage } from "../../agent-sdk-types.js";
import type { MuseHostNotification } from "./host.js";
import { MuseNotificationFold } from "./fold.js";

function frame(method: string, item: Record<string, unknown>): MuseHostNotification {
  return { method, params: { item } };
}

function createFold(echoClientMessageId: string | null = null) {
  const events: AgentStreamEvent[] = [];
  const usage: AgentUsage[] = [];
  const fold = new MuseNotificationFold("muse", {
    onEvent: (event) => events.push(event),
    resolveEchoClientMessageId: () => echoClientMessageId,
    onUsagePartial: (partial) => usage.push(partial),
  });
  return { fold, events, usage };
}

describe("MuseNotificationFold", () => {
  test("streams assistant deltas with a stable message id", () => {
    const { fold, events } = createFold();
    const item = {
      itemId: "a1",
      revision: 1,
      kind: "agentMessage",
      turnId: "t1",
      status: "inProgress",
    };

    fold.apply(frame("item/started", item));
    fold.apply({ method: "item/delta", params: { itemId: "a1", delta: "Hel", field: "text" } });
    fold.apply({ method: "item/delta", params: { itemId: "a1", delta: "lo" } });
    fold.apply(
      frame("item/completed", { ...item, revision: 2, status: "completed", text: "Hello" }),
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "muse",
        item: { type: "assistant_message", text: "Hel", messageId: "a1" },
        turnId: "t1",
      },
      {
        type: "timeline",
        provider: "muse",
        item: { type: "assistant_message", text: "lo", messageId: "a1" },
        turnId: "t1",
      },
    ]);
  });

  test("completion without deltas emits the full text once", () => {
    const { fold, events } = createFold();

    fold.apply(
      frame("item/completed", {
        itemId: "a1",
        revision: 1,
        kind: "agentMessage",
        turnId: "t1",
        status: "completed",
        text: "Hello",
      }),
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "muse",
        item: { type: "assistant_message", text: "Hello", messageId: "a1" },
        turnId: "t1",
      },
    ]);
  });

  test("user echo carries the client message id once", () => {
    const { fold, events } = createFold("client-1");
    const item = {
      itemId: "u1",
      revision: 1,
      kind: "userMessage",
      turnId: "t1",
      commandId: "t1",
      status: "completed",
      text: "full input",
      displayText: "hello",
    };

    fold.apply(frame("item/completed", item));
    fold.apply(frame("item/completed", { ...item, revision: 2 }));

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "muse",
        item: {
          type: "user_message",
          text: "hello",
          messageId: "client-1",
          clientMessageId: "client-1",
        },
        turnId: "t1",
      },
    ]);
  });

  test("tool calls run, update, and complete", () => {
    const { fold, events } = createFold();
    const base = {
      itemId: "tool-1",
      kind: "toolCall",
      turnId: "t1",
      tool: "shell_exec",
      callId: "call-1",
      args: JSON.stringify({ command: "ls" }),
    };

    fold.apply(frame("item/started", { ...base, revision: 1, status: "inProgress" }));
    fold.apply(
      frame("item/updated", {
        ...base,
        revision: 2,
        status: "inProgress",
        visibleOutput: "partial",
      }),
    );
    // Stale re-emission is ignored.
    fold.apply(frame("item/updated", { ...base, revision: 1, status: "inProgress" }));
    fold.apply(
      frame("item/completed", {
        ...base,
        revision: 3,
        status: "completed",
        visibleOutput: "total",
      }),
    );

    expect(events.map((event) => (event as { item: { status: string } }).item.status)).toEqual([
      "running",
      "running",
      "completed",
    ]);
    expect(events).toHaveLength(3);
  });

  test("turn completion terminalizes open tools before the terminal event", () => {
    const { fold, events } = createFold();

    fold.apply(
      frame("item/started", {
        itemId: "tool-1",
        revision: 1,
        kind: "toolCall",
        turnId: "t1",
        status: "inProgress",
        tool: "shell_exec",
        callId: "call-1",
      }),
    );
    fold.apply({ method: "turn/completed", params: { turnId: "t1", terminal: "cancelled" } });

    expect(events.map((event) => event.type)).toEqual(["timeline", "timeline", "turn_canceled"]);
    const terminalized = events[1] as { item: { status: string } };
    expect(terminalized.item.status).toBe("canceled");
  });

  test("maps turn terminals and failure detail", () => {
    const { fold, events } = createFold();

    fold.apply({
      method: "turn/completed",
      params: {
        turnId: "t1",
        terminal: "completed",
        usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 4 },
      },
    });
    fold.apply({
      method: "turn/completed",
      params: {
        turnId: "t2",
        terminal: "failed",
        reason: "boom",
        error: { kind: "modelError", message: "model blew up" },
      },
    });
    fold.apply({ method: "turn/completed", params: { turnId: "t3", terminal: "weird" } });

    expect(events).toEqual([
      {
        type: "turn_completed",
        provider: "muse",
        turnId: "t1",
        usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 4 },
      },
      {
        type: "turn_failed",
        provider: "muse",
        error: "model blew up",
        code: "modelError",
        turnId: "t2",
      },
      {
        type: "turn_failed",
        provider: "muse",
        error: "Muse turn ended with an unknown terminal: weird",
        turnId: "t3",
      },
    ]);
  });

  test("emits usage partials and passes turn starts through", () => {
    const { fold, events, usage } = createFold();

    fold.apply({ method: "turn/started", params: { turnId: "t1" } });
    fold.apply({
      method: "session/tokenUsage",
      params: { cumulative: { promptTokens: 100, outputTokens: 50 } },
    });
    fold.apply({
      method: "session/contextUsage",
      params: { windowTokens: 1000, usedTokens: 150 },
    });
    fold.apply({ method: "session/modelChanged", params: {} });

    expect(events).toEqual([{ type: "turn_started", provider: "muse", turnId: "t1" }]);
    expect(usage).toEqual([
      { inputTokens: 100, outputTokens: 50 },
      { contextWindowMaxTokens: 1000, contextWindowUsedTokens: 150 },
    ]);
  });

  test("streams reasoning deltas", () => {
    const { fold, events } = createFold();

    fold.apply(
      frame("item/started", {
        itemId: "r1",
        revision: 1,
        kind: "reasoning",
        turnId: "t1",
        status: "inProgress",
      }),
    );
    fold.apply({
      method: "item/delta",
      params: { itemId: "r1", delta: "thinking", field: "summary.0" },
    });
    fold.apply(
      frame("item/completed", {
        itemId: "r1",
        revision: 2,
        kind: "reasoning",
        turnId: "t1",
        status: "completed",
        summary: ["thinking"],
      }),
    );

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "muse",
        item: { type: "reasoning", text: "thinking" },
        turnId: "t1",
      },
    ]);
  });

  test("reset drops folded items and echo memory", () => {
    const { fold, events } = createFold();
    const completed = frame("item/completed", {
      itemId: "u1",
      revision: 1,
      kind: "userMessage",
      turnId: "t1",
      status: "completed",
      text: "hi",
    });

    fold.apply(completed);
    fold.apply(completed);
    expect(events).toHaveLength(1);

    fold.reset();
    fold.apply(completed);
    expect(events).toHaveLength(2);
  });
});
