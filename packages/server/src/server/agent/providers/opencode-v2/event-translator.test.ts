import { describe, expect, it } from "vitest";

import type { V2Event } from "@opencode-ai/client";

import {
  createOpenCodeV2EventTranslationState,
  resetOpenCodeV2TurnTrackingState,
  translateOpenCodeV2Event,
  type OpenCodeV2EventTranslationState,
} from "./event-translator.js";

function createState(sessionId = "session-1"): OpenCodeV2EventTranslationState {
  return createOpenCodeV2EventTranslationState(sessionId);
}

function event(
  input: Omit<V2Event, "id" | "created" | "type" | "durable"> & {
    type: V2Event["type"];
  },
): V2Event {
  return {
    id: "event-1",
    created: 1,
    durable: { aggregateID: "agg-1", seq: 1, version: 1 },
    ...input,
  } as V2Event;
}

describe("translateOpenCodeV2Event", () => {
  it("emits a user_message timeline row from session.inbox.enqueued", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.inbox.enqueued",
        data: {
          sessionID: "session-1",
          inboxID: "inbox-1",
          item: {
            type: "user",
            delivery: "default",
            payload: { text: "Hello there" },
          },
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        item: { type: "user_message", text: "Hello there", messageId: "inbox-1" },
      },
    ]);
  });

  it("does not emit the same user message twice", () => {
    const state = createState();
    const enqueued = event({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "session-1",
        inboxID: "inbox-1",
        item: {
          type: "user",
          delivery: "default",
          payload: { text: "Hello there" },
        },
      },
    });
    expect(translateOpenCodeV2Event(enqueued, state)).toHaveLength(1);
    expect(translateOpenCodeV2Event(enqueued, state)).toEqual([]);
  });

  it("carries the pending clientMessageId onto the user_message row", () => {
    const state = createOpenCodeV2EventTranslationState("session-1", {
      pendingClientMessageId: "client-msg-9",
    });
    const events = translateOpenCodeV2Event(
      event({
        type: "session.inbox.enqueued",
        data: {
          sessionID: "session-1",
          inboxID: "inbox-1",
          item: {
            type: "user",
            delivery: "default",
            payload: { text: "Hello" },
          },
        },
      }),
      state,
    );
    expect(events[0]).toMatchObject({
      item: { type: "user_message", text: "Hello", clientMessageId: "client-msg-9" },
    });
  });

  it("streams assistant text deltas correlated by assistantMessageID and ordinal", () => {
    const state = createState();
    const delta = (ordinal: number, text: string) =>
      event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal,
          delta: text,
        },
      });
    const first = translateOpenCodeV2Event(delta(0, "Hello"), state);
    const second = translateOpenCodeV2Event(delta(0, " world"), state);
    const otherOrdinal = translateOpenCodeV2Event(delta(1, "!"), state);

    expect(first).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        item: { type: "assistant_message", text: "Hello", messageId: "assistant-1" },
      },
    ]);
    expect(second[0]).toMatchObject({ item: { text: " world" } });
    expect(otherOrdinal[0]).toMatchObject({ item: { text: "!" } });
  });

  it("streams reasoning deltas correlated by assistantMessageID and ordinal", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.reasoning.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "Let me think",
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        item: { type: "reasoning", text: "Let me think" },
      },
    ]);
  });

  it("emits turn_completed with accumulated usage on session.execution.succeeded", () => {
    const state = createState();
    translateOpenCodeV2Event(
      event({
        type: "session.usage.updated",
        data: {
          sessionID: "session-1",
          cost: 0.012,
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
        },
      }),
      state,
    );
    const events = translateOpenCodeV2Event(
      event({
        type: "session.execution.succeeded",
        data: { sessionID: "session-1" },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "turn_completed",
        provider: "opencode-v2",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 50,
          contextWindowUsedTokens: 185,
          totalCostUsd: 0.012,
        },
      },
    ]);
  });

  it("emits turn_failed with the structured error on session.execution.failed", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.execution.failed",
        data: {
          sessionID: "session-1",
          error: { type: "provider.no-route", message: "Model unavailable: nope" },
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "turn_failed",
        provider: "opencode-v2",
        error: "Model unavailable: nope",
        code: "provider.no-route",
      },
    ]);
  });

  it("emits turn_canceled on session.execution.interrupted", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.execution.interrupted",
        data: { sessionID: "session-1", reason: "user" },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "turn_canceled",
        provider: "opencode-v2",
        reason: "interrupted",
      },
    ]);
  });

  it("emits a tool_call timeline from tool.called and updates it on tool.success", () => {
    const state = createState();
    translateOpenCodeV2Event(
      event({
        type: "session.tool.input.started",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          id: "tool-1",
          name: "bash",
        },
      }),
      state,
    );
    const called = translateOpenCodeV2Event(
      event({
        type: "session.tool.called",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          id: "tool-1",
          input: { command: "echo hi" },
          executed: true,
        },
      }),
      state,
    );
    expect(called[0]).toMatchObject({
      type: "timeline",
      item: {
        type: "tool_call",
        name: "bash",
        callId: "tool-1",
        status: "running",
        detail: { type: "shell", command: "echo hi" },
      },
    });

    const succeeded = translateOpenCodeV2Event(
      event({
        type: "session.tool.success",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          id: "tool-1",
          content: [{ type: "text", text: "hi" }],
          executed: true,
        },
      }),
      state,
    );
    expect(succeeded[0]).toMatchObject({
      type: "timeline",
      item: {
        type: "tool_call",
        name: "bash",
        callId: "tool-1",
        status: "completed",
      },
    });
  });

  it("emits a failed tool_call on tool.failed", () => {
    const state = createState();
    translateOpenCodeV2Event(
      event({
        type: "session.tool.input.started",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          id: "tool-1",
          name: "bash",
        },
      }),
      state,
    );
    const failed = translateOpenCodeV2Event(
      event({
        type: "session.tool.failed",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          id: "tool-1",
          error: { type: "tool.execution", message: "boom" },
          executed: true,
        },
      }),
      state,
    );
    expect(failed[0]).toMatchObject({
      type: "timeline",
      item: {
        type: "tool_call",
        name: "bash",
        callId: "tool-1",
        status: "failed",
        error: { type: "tool.execution", message: "boom" },
      },
    });
  });

  it("emits turn_completed on session.status idle and clears per-turn state", () => {
    const state = createState();
    translateOpenCodeV2Event(
      event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "Hello",
        },
      }),
      state,
    );
    const idle = translateOpenCodeV2Event(
      event({
        type: "session.status",
        data: { sessionID: "session-1", status: { type: "idle" } },
      }),
      state,
    );
    expect(idle).toEqual([{ type: "turn_completed", provider: "opencode-v2" }]);
    expect(state.textByMessage.size).toBe(0);
  });

  it("emits an error timeline row on session.status retry", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.status",
        data: {
          sessionID: "session-1",
          status: { type: "retry", attempt: 2, message: "rate limited" },
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        item: { type: "error", message: "Provider retry (attempt 2): rate limited" },
      },
    ]);
  });

  it("emits an error timeline row on session.retry.scheduled", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.retry.scheduled",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          attempt: 1,
          at: 1,
          error: { type: "provider.overloaded", message: "busy" },
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        item: {
          type: "error",
          message: "Provider retry (attempt 1) scheduled: busy",
        },
      },
    ]);
  });

  it("maps compaction lifecycle to compaction timeline items", () => {
    const state = createState();
    const started = translateOpenCodeV2Event(
      event({
        type: "session.compaction.started",
        data: { sessionID: "session-1", reason: "auto", recent: "…" },
      }),
      state,
    );
    expect(started[0]).toMatchObject({
      item: { type: "compaction", status: "loading", trigger: "auto" },
    });
    const ended = translateOpenCodeV2Event(
      event({
        type: "session.compaction.ended",
        data: { sessionID: "session-1", reason: "auto", text: "summary", recent: "…" },
      }),
      state,
    );
    expect(ended[0]).toMatchObject({
      item: { type: "compaction", status: "completed", trigger: "auto" },
    });
    const failed = translateOpenCodeV2Event(
      event({
        type: "session.compaction.failed",
        data: {
          sessionID: "session-1",
          reason: "auto",
          error: { type: "compaction", message: "nope" },
        },
      }),
      state,
    );
    expect(failed[0]).toMatchObject({
      item: { type: "error", message: "Compaction failed: nope" },
    });
  });

  it("emits usage_updated with accumulated usage", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.usage.updated",
        data: {
          sessionID: "session-1",
          cost: 0.001,
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 1 } },
        },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "usage_updated",
        provider: "opencode-v2",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          contextWindowUsedTokens: 18,
          totalCostUsd: 0.001,
        },
      },
    ]);
  });

  it("emits a tool permission_requested for permission.asked", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "permission.asked",
        data: {
          id: "perm-1",
          sessionID: "session-1",
          action: "shell",
          resources: ["bash"],
          metadata: { command: "ls -la", cwd: "/workspace" },
        },
      }),
      state,
    );
    expect(events).toHaveLength(1);
    const request = events[0];
    expect(request).toMatchObject({
      type: "permission_requested",
      provider: "opencode-v2",
      request: {
        id: "perm-1",
        name: "shell",
        kind: "tool",
        title: "Shell",
        detail: { type: "shell", command: "ls -la", cwd: "/workspace" },
      },
    });
    if (request.type === "permission_requested") {
      expect(request.request.actions).toHaveLength(3);
    }
  });

  it("emits a question permission_requested for form.created", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "form.created",
        data: {
          form: {
            id: "form-1",
            sessionID: "session-1",
            title: "Configure",
            fields: [
              {
                key: "name",
                title: "Name",
                type: "string",
                required: true,
              },
              {
                key: "tags",
                title: "Tags",
                type: "multiselect",
                options: [{ label: "a", value: "a" }],
              },
            ],
          },
        },
      }),
      state,
    );
    expect(events).toHaveLength(1);
    const request = events[0];
    expect(request).toMatchObject({
      type: "permission_requested",
      provider: "opencode-v2",
      request: {
        id: "form-1",
        name: "Configure",
        kind: "question",
        title: "Configure",
        input: {
          questions: [
            { key: "name", title: "Name", type: "string", required: true },
            { key: "tags", title: "Tags", type: "multiselect" },
          ],
        },
      },
    });
  });

  it("emits an assistant_message timeline row for session.synthetic", () => {
    const state = createState();
    const events = translateOpenCodeV2Event(
      event({
        type: "session.synthetic",
        data: { sessionID: "session-1", text: "Synthetic note" },
      }),
      state,
    );
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "opencode-v2",
        item: { type: "assistant_message", text: "Synthetic note", messageId: "event-1" },
      },
    ]);
  });

  it("ignores events from other sessions", () => {
    const state = createState("session-1");
    const events = translateOpenCodeV2Event(
      event({
        type: "session.text.delta",
        data: {
          sessionID: "session-other",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "Hello",
        },
      }),
      state,
    );
    expect(events).toEqual([]);
  });

  it("resetOpenCodeV2TurnTrackingState clears per-turn correlation maps", () => {
    const state = createState();
    translateOpenCodeV2Event(
      event({
        type: "session.text.delta",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "Hello",
        },
      }),
      state,
    );
    translateOpenCodeV2Event(
      event({
        type: "session.tool.input.started",
        data: {
          sessionID: "session-1",
          assistantMessageID: "assistant-1",
          id: "tool-1",
          name: "bash",
        },
      }),
      state,
    );
    expect(state.textByMessage.size).toBe(1);
    expect(state.toolNameByCallId.size).toBe(1);
    resetOpenCodeV2TurnTrackingState(state);
    expect(state.textByMessage.size).toBe(0);
    expect(state.toolNameByCallId.size).toBe(0);
  });
});
