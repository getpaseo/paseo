import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { deriveMessageTrailItems } from "./message-trail-items";

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(
  id: string,
  text: string,
  seed: number,
  extra?: { images?: Array<{ id: string }>; attachments?: Array<{ id: string }> },
): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: timestamp(seed),
    ...(extra?.images ? { images: extra.images as never } : {}),
    ...(extra?.attachments ? { attachments: extra.attachments as never } : {}),
  };
}

function assistantMessage(
  id: string,
  text: string,
  seed: number,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: timestamp(seed),
  };
}

function thought(id: string, text: string, seed: number): Extract<StreamItem, { kind: "thought" }> {
  return {
    kind: "thought",
    id,
    text,
    timestamp: timestamp(seed),
    status: "ready",
  };
}

function toolCall(id: string, seed: number): Extract<StreamItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    timestamp: timestamp(seed),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "test_tool",
        arguments: {},
        status: "completed",
      },
    },
  };
}

describe("deriveMessageTrailItems", () => {
  it("returns an empty array for empty inputs", () => {
    expect(deriveMessageTrailItems([], [])).toEqual([]);
  });

  it("derives a single item with no response yet", () => {
    const result = deriveMessageTrailItems([userMessage("u1", "hello", 1)], []);

    expect(result).toEqual([
      {
        id: "u1",
        ordinal: 1,
        preview: "hello",
        responsePreview: "",
        attachmentCount: 0,
      },
    ]);
  });

  it("attaches the first following assistant message as the response preview", () => {
    const result = deriveMessageTrailItems(
      [
        userMessage("u1", "question one", 1),
        thought("t1", "thinking...", 2),
        toolCall("tc1", 3),
        assistantMessage("a1", "answer one", 4),
      ],
      [],
    );

    expect(result).toEqual([
      {
        id: "u1",
        ordinal: 1,
        preview: "question one",
        responsePreview: "answer one",
        attachmentCount: 0,
      },
    ]);
  });

  it("only takes the first assistant message before the next user message", () => {
    const result = deriveMessageTrailItems(
      [
        userMessage("u1", "question one", 1),
        assistantMessage("a1", "first answer", 2),
        assistantMessage("a2", "second answer", 3),
        userMessage("u2", "question two", 4),
        assistantMessage("a3", "third answer", 5),
      ],
      [],
    );

    expect(result).toEqual([
      {
        id: "u1",
        ordinal: 1,
        preview: "question one",
        responsePreview: "first answer",
        attachmentCount: 0,
      },
      {
        id: "u2",
        ordinal: 2,
        preview: "question two",
        responsePreview: "third answer",
        attachmentCount: 0,
      },
    ]);
  });

  it("does not attribute an assistant message before any user message", () => {
    const result = deriveMessageTrailItems(
      [assistantMessage("a0", "stray answer", 1), userMessage("u1", "question", 2)],
      [],
    );

    expect(result).toEqual([
      {
        id: "u1",
        ordinal: 1,
        preview: "question",
        responsePreview: "",
        attachmentCount: 0,
      },
    ]);
  });

  it("appends streaming head items chronologically after tail", () => {
    const result = deriveMessageTrailItems(
      [userMessage("u1", "first", 1), assistantMessage("a1", "reply one", 2)],
      [userMessage("u2", "second", 3), assistantMessage("a2", "reply two", 4)],
    );

    expect(result).toEqual([
      {
        id: "u1",
        ordinal: 1,
        preview: "first",
        responsePreview: "reply one",
        attachmentCount: 0,
      },
      {
        id: "u2",
        ordinal: 2,
        preview: "second",
        responsePreview: "reply two",
        attachmentCount: 0,
      },
    ]);
  });

  it("handles a user message in tail whose response streams in via head", () => {
    const result = deriveMessageTrailItems(
      [userMessage("u1", "first", 1)],
      [assistantMessage("a1", "streamed reply", 2)],
    );

    expect(result[0]?.responsePreview).toBe("streamed reply");
  });

  it("normalizes whitespace runs to single spaces and trims", () => {
    const result = deriveMessageTrailItems(
      [userMessage("u1", "  hello\n\n  world\t\tagain  ", 1)],
      [],
    );

    expect(result[0]?.preview).toBe("hello world again");
  });

  it("caps preview and responsePreview at 280 characters after normalization", () => {
    const longText = "a".repeat(300);
    const result = deriveMessageTrailItems(
      [userMessage("u1", longText, 1), assistantMessage("a1", longText, 2)],
      [],
    );

    expect(result[0]?.preview).toHaveLength(280);
    expect(result[0]?.preview).toBe("a".repeat(280));
    expect(result[0]?.responsePreview).toHaveLength(280);
  });

  it("counts images and attachments together", () => {
    const result = deriveMessageTrailItems(
      [
        userMessage("u1", "with attachments", 1, {
          images: [{ id: "img1" }, { id: "img2" }],
          attachments: [{ id: "att1" }],
        }),
      ],
      [],
    );

    expect(result[0]?.attachmentCount).toBe(3);
  });

  it("counts zero attachments when images and attachments are absent", () => {
    const result = deriveMessageTrailItems([userMessage("u1", "plain", 1)], []);

    expect(result[0]?.attachmentCount).toBe(0);
  });

  it("assigns sequential 1-based ordinals across multiple user messages", () => {
    const result = deriveMessageTrailItems(
      [userMessage("u1", "one", 1), userMessage("u2", "two", 2), userMessage("u3", "three", 3)],
      [],
    );

    expect(result.map((item) => item.ordinal)).toEqual([1, 2, 3]);
  });

  it("continues ordinals across the tail/head boundary", () => {
    const result = deriveMessageTrailItems(
      [userMessage("u1", "one", 1), userMessage("u2", "two", 2)],
      [userMessage("u3", "three", 3)],
    );

    expect(result.map((item) => item.ordinal)).toEqual([1, 2, 3]);
  });

  it("counts images when attachments are absent", () => {
    const result = deriveMessageTrailItems(
      [
        userMessage("u1", "with images", 1, {
          images: [{ id: "img1" }, { id: "img2" }],
        }),
      ],
      [],
    );

    expect(result[0]?.attachmentCount).toBe(2);
  });

  it("counts attachments when images are absent", () => {
    const result = deriveMessageTrailItems(
      [
        userMessage("u1", "with attachments", 1, {
          attachments: [{ id: "att1" }],
        }),
      ],
      [],
    );

    expect(result[0]?.attachmentCount).toBe(1);
  });

  describe("response attribution", () => {
    it("does not overwrite responsePreview once the first assistant message is captured", () => {
      const result = deriveMessageTrailItems(
        [
          userMessage("u1", "question", 1),
          assistantMessage("a1", "first", 2),
          thought("t1", "thinking...", 3),
          assistantMessage("a2", "second", 4),
        ],
        [],
      );

      expect(result).toEqual([
        {
          id: "u1",
          ordinal: 1,
          preview: "question",
          responsePreview: "first",
          attachmentCount: 0,
        },
      ]);
    });

    it("skips tool_call and thought items when choosing the response", () => {
      const result = deriveMessageTrailItems(
        [
          userMessage("u1", "question", 1),
          toolCall("tc1", 2),
          thought("t1", "thinking...", 3),
          assistantMessage("a1", "answer", 4),
        ],
        [],
      );

      expect(result).toEqual([
        {
          id: "u1",
          ordinal: 1,
          preview: "question",
          responsePreview: "answer",
          attachmentCount: 0,
        },
      ]);
    });

    it("leaves responsePreview empty when only tool_calls and thoughts follow a user message", () => {
      const result = deriveMessageTrailItems(
        [userMessage("u1", "question", 1), toolCall("tc1", 2), thought("t1", "thinking...", 3)],
        [],
      );

      expect(result).toEqual([
        {
          id: "u1",
          ordinal: 1,
          preview: "question",
          responsePreview: "",
          attachmentCount: 0,
        },
      ]);
    });

    it("attributes the first assistant even when a thought precedes it in the same turn", () => {
      const result = deriveMessageTrailItems(
        [
          userMessage("u1", "question", 1),
          thought("t1", "thinking...", 2),
          assistantMessage("a1", "a", 3),
        ],
        [],
      );

      expect(result).toEqual([
        {
          id: "u1",
          ordinal: 1,
          preview: "question",
          responsePreview: "a",
          attachmentCount: 0,
        },
      ]);
    });
  });

  describe("preview normalization", () => {
    it("returns an empty preview for whitespace-only user text", () => {
      const result = deriveMessageTrailItems([userMessage("u1", "   \n\t ", 1)], []);

      expect(result[0]?.preview).toBe("");
    });

    it("keeps a preview of exactly 280 characters uncapped", () => {
      const exactText = "a".repeat(280);
      const result = deriveMessageTrailItems([userMessage("u1", exactText, 1)], []);

      expect(result[0]?.preview).toHaveLength(280);
      expect(result[0]?.preview).toBe(exactText);
    });

    it("caps to 280 only after collapsing whitespace", () => {
      const rawText = "aa   ".repeat(120); // 600 raw characters; "   " runs collapse to " "
      const result = deriveMessageTrailItems([userMessage("u1", rawText, 1)], []);

      const collapsed = rawText.replace(/\s+/g, " ").trim();
      expect(collapsed).toHaveLength(359);
      expect(result[0]?.preview).toHaveLength(280);
      expect(result[0]?.preview).toBe(collapsed.slice(0, 280));
    });

    it("normalizes the responsePreview with the same rules as the preview", () => {
      const longAssistantText = `line one\n\n${"b".repeat(300)}`;
      const result = deriveMessageTrailItems(
        [userMessage("u1", "question", 1), assistantMessage("a1", longAssistantText, 2)],
        [],
      );

      const expectedCollapsed = longAssistantText.replace(/\s+/g, " ").trim().slice(0, 280);
      expect(result[0]?.responsePreview).toHaveLength(280);
      expect(result[0]?.responsePreview).toBe(expectedCollapsed);
    });
  });
});
