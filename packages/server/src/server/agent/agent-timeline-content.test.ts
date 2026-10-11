import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "./agent-sdk-types.js";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test("marks truncated plain-text tool content within the content budget", () => {
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

    expect(limitAgentTimelineItemContent(item)).toEqual(item);
    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024 - "\n\n[Content truncated]".length) + "\n\n[Content truncated]",
        icon: "square_terminal",
      },
    });
  });

  test.each([64 * 1024 - 1, 64 * 1024])(
    "preserves search detail identity below and at the tool-call content budget (size %d)",
    (size) => {
      const item: AgentTimelineItem = {
        type: "tool_call",
        callId: `search-content-size-${size}`,
        name: "grep",
        status: "completed",
        error: null,
        detail: {
          type: "search",
          query: "limitAgentTimelineItemContent",
          toolName: "grep",
          content: "x".repeat(size),
          filePaths: ["src/example.ts"],
          numMatches: 29,
        },
      };

      expect(limitAgentTimelineItemContent(item)).toBe(item);
    },
  );

  test("bounds oversized search content while retaining metadata", () => {
    const limited = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "search-oversized",
      name: "grep",
      status: "completed",
      error: null,
      detail: {
        type: "search",
        query: "limitAgentTimelineItemContent",
        toolName: "grep",
        content: "m".repeat(64 * 1024 + 1),
        filePaths: ["src/example.ts"],
        webResults: [{ title: "Docs", url: "https://example.com/docs" }],
        annotations: ["cwd /example/project"],
        numFiles: 1,
        numMatches: 29,
        durationMs: 42,
        truncated: false,
        mode: "content",
      },
    });

    expect(limited).toEqual({
      type: "tool_call",
      callId: "search-oversized",
      name: "grep",
      status: "completed",
      error: null,
      detail: {
        type: "search",
        query: "limitAgentTimelineItemContent",
        toolName: "grep",
        content: "m".repeat(64 * 1024),
        filePaths: ["src/example.ts"],
        webResults: [{ title: "Docs", url: "https://example.com/docs" }],
        annotations: ["cwd /example/project"],
        numFiles: 1,
        numMatches: 29,
        durationMs: 42,
        truncated: true,
        mode: "content",
      },
    });
  });

  test("leaves search details without string content untouched", () => {
    const item: AgentTimelineItem = {
      type: "tool_call",
      callId: "search-no-content",
      name: "web_search",
      status: "completed",
      error: null,
      detail: {
        type: "search",
        query: "latest release",
        toolName: "web_search",
        content: undefined,
        webResults: [{ title: "Docs", url: "https://example.com/docs" }],
      },
    };

    expect(limitAgentTimelineItemContent(item)).toBe(item);
  });
});
