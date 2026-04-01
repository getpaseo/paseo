import { describe, expect, it } from "vitest";

import { translateOpenCodeEvent, type OpenCodeEventTranslationState } from "../opencode-agent.js";

function createState(sessionId = "session-1"): OpenCodeEventTranslationState {
  return {
    sessionId,
    messageRoles: new Map(),
    accumulatedUsage: {},
    streamedPartKeys: new Set(),
    emittedStructuredMessageIds: new Set(),
  };
}

describe("translateOpenCodeEvent", () => {
  it("does not duplicate assistant output when completed part echoes streamed delta", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-1",
            sessionID: "session-1",
            role: "assistant",
          },
        },
      },
      state,
    );

    const streamed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          delta: "hey! what can I help with?",
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            time: { start: 1 },
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "session-1",
            messageID: "message-1",
            type: "text",
            text: "hey! what can I help with?",
            time: { start: 1, end: 2 },
          },
        },
      },
      state,
    );

    const assistantEvents = [...streamed, ...completed].filter(
      (event) => event.type === "timeline" && event.item.type === "assistant_message",
    );

    expect(assistantEvents).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "hey! what can I help with?" },
      },
    ]);
  });

  it("emits completed assistant text when no delta was streamed", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-2",
            sessionID: "session-1",
            role: "assistant",
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-2",
            sessionID: "session-1",
            messageID: "message-2",
            type: "text",
            text: "final text",
            time: { start: 3, end: 4 },
          },
        },
      },
      state,
    );

    expect(completed).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "final text" },
      },
    ]);
  });

  it("does not duplicate reasoning output when completed part echoes streamed delta", () => {
    const state = createState();

    const streamed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          delta: "The user said hello.",
          part: {
            id: "reasoning-part-1",
            sessionID: "session-1",
            messageID: "message-3",
            type: "reasoning",
            time: { start: 10 },
          },
        },
      },
      state,
    );

    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "reasoning-part-1",
            sessionID: "session-1",
            messageID: "message-3",
            type: "reasoning",
            text: "The user said hello.",
            time: { start: 10, end: 11 },
          },
        },
      },
      state,
    );

    const reasoningEvents = [...streamed, ...completed].filter(
      (event) => event.type === "timeline" && event.item.type === "reasoning",
    );

    expect(reasoningEvents).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "reasoning", text: "The user said hello." },
      },
    ]);
  });

  it("emits assistant text from message.part.delta events", () => {
    const state = createState();

    // Register message role
    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-d1", sessionID: "session-1", role: "assistant" },
        },
      },
      state,
    );

    // OpenCode v2 can send streaming text as message.part.delta
    const delta1 = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-d1",
          partID: "part-d1",
          field: "text",
          delta: "hey! ",
        },
      },
      state,
    );

    const delta2 = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-d1",
          partID: "part-d1",
          field: "text",
          delta: "what's up?",
        },
      },
      state,
    );

    expect([...delta1, ...delta2]).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "hey! " },
      },
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "what's up?" },
      },
    ]);
  });

  it("emits reasoning from message.part.delta events", () => {
    const state = createState();

    const delta = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-r1",
          partID: "rp-1",
          field: "reasoning",
          delta: "The user said hello.",
        },
      },
      state,
    );

    expect(delta).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "reasoning", text: "The user said hello." },
      },
    ]);
  });

  it("deduplicates when message.part.delta is followed by completed message.part.updated", () => {
    const state = createState();

    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-dd1", sessionID: "session-1", role: "assistant" },
        },
      },
      state,
    );

    // Stream via delta event
    const streamed = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-dd1",
          partID: "part-dd1",
          field: "text",
          delta: "hello there",
        },
      },
      state,
    );

    // Completed part echoes the same text
    const completed = translateOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-dd1",
            sessionID: "session-1",
            messageID: "msg-dd1",
            type: "text",
            text: "hello there",
            time: { start: 1, end: 2 },
          },
        },
      },
      state,
    );

    const all = [...streamed, ...completed].filter(
      (e) => e.type === "timeline" && e.item.type === "assistant_message",
    );
    // Only the delta, not the completed echo
    expect(all).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: "hello there" },
      },
    ]);
  });

  it("ignores message.part.delta for wrong session", () => {
    const state = createState();

    const result = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "other-session",
          messageID: "msg-1",
          partID: "part-1",
          field: "text",
          delta: "should not appear",
        },
      },
      state,
    );

    expect(result).toEqual([]);
  });

  it("ignores message.part.delta for user messages", () => {
    const state = createState();

    // Register as user message
    translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: { id: "msg-u1", sessionID: "session-1", role: "user" },
        },
      },
      state,
    );

    const result = translateOpenCodeEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-1",
          messageID: "msg-u1",
          partID: "part-u1",
          field: "text",
          delta: "user typing",
        },
      },
      state,
    );

    expect(result).toEqual([]);
  });

  it("emits structured assistant output when schema mode completes without text parts", () => {
    const state = createState();

    const first = translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-structured-1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { summary: "hello" },
          },
        },
      },
      state,
    );

    const second = translateOpenCodeEvent(
      {
        type: "message.updated",
        properties: {
          info: {
            id: "message-structured-1",
            sessionID: "session-1",
            role: "assistant",
            time: { created: 1, completed: 2 },
            structured: { summary: "hello" },
          },
        },
      },
      state,
    );

    expect(first).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "assistant_message", text: '{"summary":"hello"}' },
      },
    ]);
    expect(second).toEqual([]);
  });
});
