import { describe, expect, it } from "vitest";
import { splitComposerAttachmentsForSubmit } from "./submit";

describe("selected text composer submission", () => {
  it("sends selected assistant text as a text context attachment", () => {
    expect(
      splitComposerAttachmentsForSubmit([
        {
          kind: "selected_text",
          id: "selected_text:1",
          text: "Keep this invariant.",
        },
      ]),
    ).toEqual({
      images: [],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "Selected text from the previous response",
          text: [
            "The user selected this text from your previous response. Their message comments on or refers to this selection:",
            "<user_selected_text>",
            "Keep this invariant.",
            "</user_selected_text>",
          ].join("\n"),
        },
      ],
    });
  });
});
