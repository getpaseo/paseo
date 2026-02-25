import { describe, expect, it } from "vitest";

import {
  translateOpenCodeEvent,
  type OpenCodeEventTranslationState,
} from "../opencode-agent.js";

function createState(sessionId = "session-1"): OpenCodeEventTranslationState {
  return {
    sessionId,
    messageRoles: new Map(),
    accumulatedUsage: {},
    streamedPartKeys: new Set(),
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
      state
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
      state
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
      state
    );

    const assistantEvents = [...streamed, ...completed].filter(
      (event) => event.type === "timeline" && event.item.type === "assistant_message"
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
      state
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
      state
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
      state
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
      state
    );

    const reasoningEvents = [...streamed, ...completed].filter(
      (event) => event.type === "timeline" && event.item.type === "reasoning"
    );

    expect(reasoningEvents).toEqual([
      {
        type: "timeline",
        provider: "opencode",
        item: { type: "reasoning", text: "The user said hello." },
      },
    ]);
  });
});
