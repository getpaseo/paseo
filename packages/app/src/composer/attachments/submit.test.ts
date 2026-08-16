import { describe, expect, it } from "vitest";
import { splitComposerAttachmentsForSubmit } from "./submit";

describe("selected text composer submission", () => {
  it("sends all selected-text comments in one context attachment", () => {
    const result = splitComposerAttachmentsForSubmit([
      {
        kind: "selected_text",
        id: "selected_text:1",
        text: "Keep this invariant.",
        comment: "Explain why",
      },
      {
        kind: "selected_text",
        id: "selected_text:2",
        text: "Do not retry.",
        comment: "Is this still required?",
      },
    ]);

    expect(result.images).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "Selected text from the previous response",
      text: [
        "<user_comments>",
        "<id>1</id>",
        "<selected_text>",
        "Keep this invariant.",
        "</selected_text>",
        "<comment>",
        "Explain why",
        "</comment>",
        "</user_comments>",
        "<user_comments>",
        "<id>2</id>",
        "<selected_text>",
        "Do not retry.",
        "</selected_text>",
        "<comment>",
        "Is this still required?",
        "</comment>",
        "</user_comments>",
      ].join("\n"),
    });
  });
});
