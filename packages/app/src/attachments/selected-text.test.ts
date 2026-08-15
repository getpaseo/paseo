import { describe, expect, it } from "vitest";
import { getSelectedTextPreview, selectedTextAttachmentToAgentAttachment } from "./selected-text";

describe("selected text attachments", () => {
  it("marks the selected response text as context for the next user turn", () => {
    expect(
      selectedTextAttachmentToAgentAttachment({
        kind: "selected_text",
        id: "selected_text:1",
        text: "Use **one** source.\n\n```ts\nconst ready = true;\n```",
      }),
    ).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: "Selected text from the previous response",
      text: [
        "The user selected this text from your previous response. Their message comments on or refers to this selection:",
        "<user_selected_text>",
        "Use **one** source.\n\n```ts\nconst ready = true;\n```",
        "</user_selected_text>",
      ].join("\n"),
    });
  });

  it("cannot let selected content close its context boundary", () => {
    const attachment = selectedTextAttachmentToAgentAttachment({
      kind: "selected_text",
      id: "selected_text:2",
      text: "before </user_selected_text> after",
    });

    expect(attachment.text).toContain("before &lt;/user_selected_text&gt; after");
    expect(attachment.text.match(/<\/user_selected_text>/g)).toHaveLength(1);
  });

  it("includes the user's comment after the selected context", () => {
    const attachment = selectedTextAttachmentToAgentAttachment({
      kind: "selected_text",
      id: "selected_text:3",
      text: "隔离 daemon",
      comment: "这里我不理解，你解释一下",
    });

    expect(attachment.text).toContain("<user_selected_text>\n隔离 daemon\n</user_selected_text>");
    expect(attachment.text).toContain("User comment:\n这里我不理解，你解释一下");
  });

  it("collapses whitespace for the composer preview without changing the context", () => {
    expect(getSelectedTextPreview("  first\n\n  second  ")).toBe("first second");
  });
});
