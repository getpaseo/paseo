import { describe, expect, test } from "vitest";

import { wrapSpokenInput } from "../voice-config.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test("shows only the transcript from a spoken-input prompt", () => {
    const item = limitAgentTimelineItemContent({
      type: "user_message",
      text: wrapSpokenInput("用语音回答测试成功。"),
      messageId: "provider-message-1",
    });

    expect(item).toEqual({
      type: "user_message",
      text: "用语音回答测试成功。",
      messageId: "provider-message-1",
    });
  });

  test("leaves ordinary user messages unchanged", () => {
    const item = {
      type: "user_message" as const,
      text: "Please keep <spoken-input> examples in my documentation.",
      messageId: "provider-message-2",
    };

    expect(limitAgentTimelineItemContent(item)).toBe(item);
  });

  test("limits terminal input to the tool-call content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024),
        icon: "square_terminal",
      },
    });
  });
});
