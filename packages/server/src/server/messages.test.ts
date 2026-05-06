import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "./agent/agent-sdk-types.js";
import { serializeAgentStreamEvent } from "./messages.js";

describe("serializeAgentStreamEvent", () => {
  test("preserves user_message text as-is", () => {
    const event: AgentStreamEvent = {
      type: "timeline",
      provider: "claude",
      item: {
        type: "user_message",
        text: "<paseo-instructions>\nX\n</paseo-instructions>\n\nHello",
        messageId: "m1",
      },
    };

    const serialized = serializeAgentStreamEvent(event);
    expect(serialized).not.toBeNull();
    if (!serialized || serialized.type !== "timeline" || serialized.item.type !== "user_message") {
      throw new Error("Expected timeline.user_message event");
    }
    expect(serialized.item.text).toBe(event.item.text);
    expect(serialized.item.messageId).toBe("m1");
  });

  test("passes canonical tool_call payloads through unchanged", () => {
    const event: AgentStreamEvent = {
      type: "timeline",
      provider: "codex",
      item: {
        type: "tool_call",
        callId: "call_1",
        name: "shell",
        status: "running",
        detail: {
          type: "shell",
          command: "pwd",
        },
        error: null,
      },
    };

    const serialized = serializeAgentStreamEvent(event);
    expect(serialized).not.toBeNull();
    if (!serialized || serialized.type !== "timeline" || serialized.item.type !== "tool_call") {
      throw new Error("Expected timeline.tool_call event");
    }
    expect(serialized.item.status).toBe("running");
    expect(serialized.item.error).toBeNull();
  });

  test("passes unknown-detail tool_call payloads through unchanged", () => {
    const event: AgentStreamEvent = {
      type: "timeline",
      provider: "codex",
      item: {
        type: "tool_call",
        callId: "call_unknown",
        name: "paseo_voice.speak",
        status: "completed",
        detail: {
          type: "unknown",
          input: { text: "hello" },
          output: { ok: true },
        },
        error: null,
      },
    };

    const serialized = serializeAgentStreamEvent(event);
    expect(serialized).not.toBeNull();
    if (!serialized || serialized.type !== "timeline" || serialized.item.type !== "tool_call") {
      throw new Error("Expected timeline.tool_call event");
    }
    expect(serialized.item.detail).toEqual({
      type: "unknown",
      input: { text: "hello" },
      output: { ok: true },
    });
  });

  test("drops invalid legacy tool_call items", () => {
    const event = {
      type: "timeline",
      provider: "codex",
      item: {
        type: "tool_call",
        callId: "call_legacy",
        name: "shell",
        status: "inProgress",
        detail: {
          type: "unknown",
          input: { command: "pwd" },
          output: null,
        },
      },
    } satisfies unknown;

    const serialized = serializeAgentStreamEvent(event as AgentStreamEvent);
    expect(serialized).toBeNull();
  });

  test("drops internal session config drift events from websocket payloads", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "mode_changed",
        provider: "codex",
        currentModeId: "build",
        availableModes: [{ id: "build", label: "Build" }],
      },
      {
        type: "model_changed",
        provider: "codex",
        runtimeInfo: { provider: "codex", sessionId: "session-1", model: "gpt-5.4" },
      },
      {
        type: "thinking_option_changed",
        provider: "codex",
        thinkingOptionId: "high",
      },
    ];

    expect(events.map((event) => serializeAgentStreamEvent(event))).toEqual([null, null, null]);
  });
});
