import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import {
  appendMessagePreview,
  buildMessagePreview,
  capMessagePreviewText,
  MESSAGE_PREVIEW_LIMIT,
  MESSAGE_PREVIEW_TEXT_LIMIT,
  messagePreviewSnippet,
  type AgentMessagePreview,
} from "./message-preview.js";

const userPrompt: AgentTimelineItem = { type: "user_message", text: "explain the importer" };
const assistantChunk: AgentTimelineItem = { type: "assistant_message", text: "the " };
const reasoning: AgentTimelineItem = { type: "reasoning", text: "thinking about it" };

function append(
  preview: readonly AgentMessagePreview[],
  item: AgentTimelineItem,
  previousItem?: AgentTimelineItem,
): AgentMessagePreview[] {
  if (item.type !== "user_message" && item.type !== "assistant_message") {
    throw new Error("test helper only appends messages");
  }
  return appendMessagePreview(preview, item, previousItem);
}

describe("capMessagePreviewText", () => {
  it("collapses whitespace and trims", () => {
    expect(capMessagePreviewText("  hello\n\tworld  ")).toBe("hello world");
  });

  it("cuts long text on the budget and marks the cut", () => {
    const capped = capMessagePreviewText("x".repeat(MESSAGE_PREVIEW_TEXT_LIMIT + 50));
    expect(capped).toHaveLength(MESSAGE_PREVIEW_TEXT_LIMIT);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("keeps text that fits exactly", () => {
    const exact = "y".repeat(MESSAGE_PREVIEW_TEXT_LIMIT);
    expect(capMessagePreviewText(exact)).toBe(exact);
  });
});

describe("appendMessagePreview", () => {
  it("appends a question and then the reply", () => {
    const withPrompt = append([], userPrompt);
    expect(withPrompt).toEqual([{ role: "user", text: "explain the importer" }]);
    expect(append(withPrompt, { type: "assistant_message", text: "done" }, userPrompt)).toEqual([
      { role: "user", text: "explain the importer" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("joins contiguous assistant chunks into one reply", () => {
    const preview = append([], assistantChunk, reasoning);
    const joined = append(preview, { type: "assistant_message", text: "answer" }, assistantChunk);
    expect(joined).toEqual([{ role: "assistant", text: "the answer" }]);
  });

  it("joins chunks that share a message id", () => {
    const first = {
      type: "assistant_message" as const,
      text: "the ",
      messageId: "msg-1",
    };
    const preview = append([], first);
    const joined = append(
      preview,
      { type: "assistant_message", text: "answer", messageId: "msg-1" },
      first,
    );
    expect(joined).toEqual([{ role: "assistant", text: "the answer" }]);
  });

  it("keeps a later reply when an earlier one already filled the cap", () => {
    const first = {
      type: "assistant_message" as const,
      text: "a".repeat(MESSAGE_PREVIEW_TEXT_LIMIT),
      messageId: "msg-1",
    };
    const preview = append([], first);
    const separated = append(
      preview,
      { type: "assistant_message", text: "find the kumquat", messageId: "msg-2" },
      first,
    );
    expect(separated).toEqual([
      { role: "assistant", text: "a".repeat(MESSAGE_PREVIEW_TEXT_LIMIT) },
      { role: "assistant", text: "find the kumquat" },
    ]);
  });

  it("starts a new reply when a reasoning step came between chunks", () => {
    const preview = append([], assistantChunk, reasoning);
    const separated = append(
      preview,
      { type: "assistant_message", text: "second reply" },
      reasoning,
    );
    expect(separated).toEqual([
      { role: "assistant", text: "the " },
      { role: "assistant", text: "second reply" },
    ]);
  });

  it("drops the oldest message once the window is full", () => {
    let preview: AgentMessagePreview[] = [];
    for (let index = 0; index < MESSAGE_PREVIEW_LIMIT + 2; index += 1) {
      preview = append(preview, { type: "user_message", text: `question ${index}` });
    }
    expect(preview).toHaveLength(MESSAGE_PREVIEW_LIMIT);
    expect(preview.at(0)).toEqual({ role: "user", text: "question 2" });
    expect(preview.at(-1)).toEqual({ role: "user", text: "question 6" });
  });

  it("keeps a question that arrived long before the reply", () => {
    const preview = append([], userPrompt);
    // Hundreds of reasoning or tool items can sit between the question and the
    // reply. They never reach the preview, and the reply must not push the
    // question out — rebuilding from a bounded timeline slice would.
    const reply = append(preview, { type: "assistant_message", text: "done" }, reasoning);
    expect(reply).toEqual([
      { role: "user", text: "explain the importer" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("caps a joined reply and does not keep the previous ellipsis", () => {
    const long = capMessagePreviewText("a".repeat(MESSAGE_PREVIEW_TEXT_LIMIT + 20));
    expect(long.endsWith("…")).toBe(true);
    const joined = append(
      [{ role: "assistant", text: long }],
      { type: "assistant_message", text: "tail" },
      assistantChunk,
    );
    expect(joined[0]?.text).toHaveLength(MESSAGE_PREVIEW_TEXT_LIMIT);
    expect(joined[0]?.text).not.toContain("…tail");
  });
});

describe("buildMessagePreview", () => {
  it("folds a whole timeline, merging streamed chunks and ignoring the rest", () => {
    const reasoningItem: AgentTimelineItem = { type: "reasoning", text: "thinking" };
    expect(
      buildMessagePreview([
        userPrompt,
        reasoningItem,
        assistantChunk,
        { type: "assistant_message", text: "answer" },
        { type: "todo", items: [] },
      ]),
    ).toEqual([
      { role: "user", text: "explain the importer" },
      { role: "assistant", text: "the answer" },
    ]);
  });

  it("returns nothing for a timeline without messages", () => {
    expect(buildMessagePreview([{ type: "reasoning", text: "thinking" }])).toEqual([]);
  });
});

describe("messagePreviewSnippet", () => {
  const preview = [
    { role: "user" as const, text: "please rename the legacy importer" },
    { role: "assistant" as const, text: "I renamed the importer and updated its callers" },
  ];

  it("returns null when no message carries a token", () => {
    expect(messagePreviewSnippet(["kubernetes"], preview)).toBeNull();
  });

  it("returns null without tokens", () => {
    expect(messagePreviewSnippet([], preview)).toBeNull();
  });

  it("matches the newest message first", () => {
    expect(messagePreviewSnippet(["importer"], preview)).toEqual({
      role: "assistant",
      text: "I renamed the importer and updated its callers",
    });
  });

  it("keeps the match inside the window and marks both cuts", () => {
    const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`;
    const snippet = messagePreviewSnippet(["needle"], [{ role: "user", text: long }], 100);
    expect(snippet?.text).toContain("needle");
    expect(snippet?.text.length).toBeLessThanOrEqual(102);
    expect(snippet?.text.startsWith("…")).toBe(true);
    expect(snippet?.text.endsWith("…")).toBe(true);
  });
});
