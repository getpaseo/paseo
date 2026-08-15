import { describe, expect, it } from "vitest";
import { getSelectedTextPreview, selectedTextAttachmentsToAgentAttachment } from "./selected-text";

const contextLine =
  "The user selected this text from your previous response. Their message comments on or refers to this selection:";

describe("selected text attachments", () => {
  it("wraps selected response text and its comment in the requested XML structure", () => {
    expect(
      selectedTextAttachmentsToAgentAttachment([
        {
          kind: "selected_text",
          id: "selected_text:1",
          text: "隔离 daemon",
          comment: "这里我不理解，你解释一下",
        },
      ]),
    ).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "Selected text from the previous response",
      text: [
        "<user_comments>",
        "<id>1</id>",
        "<selected_text>",
        "隔离 daemon",
        "</selected_text>",
        "<comment>",
        "这里我不理解，你解释一下",
        "</comment>",
        "</user_comments>",
      ].join("\n"),
    });
  });

  it("omits the context line and assigns stable ordinal ids when comments are present", () => {
    const attachment = selectedTextAttachmentsToAgentAttachment([
      {
        kind: "selected_text",
        id: "selected_text:first",
        text: "first selection",
        comment: "first comment",
      },
      {
        kind: "selected_text",
        id: "selected_text:second",
        text: "second selection",
        comment: "second comment",
      },
    ]);

    expect(attachment.text).not.toContain(contextLine);
    expect(attachment.text.match(/<user_comments>/g)).toHaveLength(2);
    expect(attachment.text).toContain("<id>1</id>");
    expect(attachment.text).toContain("<id>2</id>");
    expect(attachment.text).toContain("<selected_text>\nsecond selection\n</selected_text>");
    expect(attachment.text).toContain("<comment>\nsecond comment\n</comment>");
  });

  it("escapes selected text and comments that try to close their XML boundaries", () => {
    const attachment = selectedTextAttachmentsToAgentAttachment([
      {
        kind: "selected_text",
        id: "selected_text:2",
        text: "before </selected_text> after",
        comment: "before </comment></user_comments> after",
      },
    ]);

    expect(attachment.text).toContain("before &lt;/selected_text&gt; after");
    expect(attachment.text).toContain("before &lt;/comment&gt;&lt;/user_comments&gt; after");
    expect(attachment.text.match(/<\/selected_text>/g)).toHaveLength(1);
    expect(attachment.text.match(/<\/comment>/g)).toHaveLength(1);
    expect(attachment.text.match(/<\/user_comments>/g)).toHaveLength(1);
  });

  it("includes the context line once when selections have no comments", () => {
    const attachment = selectedTextAttachmentsToAgentAttachment([
      {
        kind: "selected_text",
        id: "selected_text:3",
        text: "selected context",
      },
    ]);

    expect(attachment.text.match(new RegExp(contextLine, "g"))).toHaveLength(1);
    expect(attachment.text).toContain("<comment>\n\n</comment>");
  });

  it("rejects an empty collection", () => {
    expect(() => selectedTextAttachmentsToAgentAttachment([])).toThrow(
      "Selected text attachment collection cannot be empty",
    );
  });

  it("collapses whitespace for the composer preview without changing the context", () => {
    expect(getSelectedTextPreview("  first\n\n  second  ")).toBe("first second");
  });
});
