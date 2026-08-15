import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { SelectedTextComposerAttachment } from "@/attachments/types";

const SELECTED_TEXT_OPEN_TAG = "<user_selected_text>";
const SELECTED_TEXT_CLOSE_TAG = "</user_selected_text>";

export function selectedTextAttachmentToAgentAttachment(
  attachment: SelectedTextComposerAttachment,
): Extract<AgentAttachment, { type: "text" }> {
  const text = attachment.text.replaceAll(SELECTED_TEXT_CLOSE_TAG, "&lt;/user_selected_text&gt;");
  const comment = attachment.comment?.trim();
  return {
    type: "text",
    mimeType: "text/plain",
    title: "Selected text from the previous response",
    text: [
      "The user selected this text from your previous response. Their message comments on or refers to this selection:",
      SELECTED_TEXT_OPEN_TAG,
      text,
      SELECTED_TEXT_CLOSE_TAG,
      ...(comment ? ["User comment:", comment] : []),
    ].join("\n"),
  };
}

export function getSelectedTextPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
