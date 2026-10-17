import { describe, expect, test } from "vitest";

import { convertClaudeHistoryEntry, extractUserMessageText } from "./agent.js";
import type { AgentTimelineItem } from "../../agent-sdk-types.js";

describe("Claude assistant history identity", () => {
  test.each([false, true])("preserves the live message ID with tool blocks: %s", (withTool) => {
    const content = [{ type: "text", text: "reply" }];
    const blocks = withTool
      ? [...content, { type: "tool_use", id: "tool-1", name: "Read", input: {} }]
      : content;
    const mapped: AgentTimelineItem[] = [{ type: "assistant_message", text: "reply" }];
    expect(
      convertClaudeHistoryEntry(
        {
          type: "assistant",
          uuid: "transcript-id",
          message: { id: "provider-id", content: blocks },
        },
        () => mapped,
      ),
    ).toEqual([{ type: "assistant_message", text: "reply", messageId: "provider-id" }]);
  });

  test("retains UUID identity for transcript entries without an API message ID", () => {
    expect(
      convertClaudeHistoryEntry(
        { type: "assistant", uuid: "transcript-only-id", message: { content: "reply" } },
        () => [{ type: "assistant_message", text: "reply" }],
      ),
    ).toEqual([{ type: "assistant_message", text: "reply", messageId: "transcript-only-id" }]);
  });
});

describe("extractUserMessageText", () => {
  test("returns trimmed string content", () => {
    expect(extractUserMessageText("  Hello world  ")).toBe("Hello world");
  });

  test("combines multiple text blocks", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];

    expect(extractUserMessageText(content)).toBe("First line\n\nSecond line");
  });

  test("returns Claude slash command prompts without transcript tags", () => {
    const content =
      "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>recently the PR data does not update</command-args>";

    expect(extractUserMessageText(content)).toBe("/diagnose recently the PR data does not update");
  });

  test("returns the Claude slash command prompt when no args were recorded", () => {
    const content =
      "<command-message>caveman:caveman</command-message>\n<command-name>/caveman:caveman</command-name>";

    expect(extractUserMessageText(content)).toBe("/caveman:caveman");
  });

  test("returns null when no textual content is present", () => {
    const content = [
      { type: "image", source: "foo.png" },
      { type: "file", path: "bar.txt" },
    ];

    expect(extractUserMessageText(content)).toBeNull();
  });
});
