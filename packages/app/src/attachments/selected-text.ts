import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { SelectedTextComposerAttachment } from "@/attachments/types";

const SELECTED_TEXT_CONTEXT =
  "The user selected this text from your previous response. Their message comments on or refers to this selection:";

export function selectedTextAttachmentsToAgentAttachment(
  attachments: readonly SelectedTextComposerAttachment[],
): Extract<AgentAttachment, { type: "text" }> {
  if (attachments.length === 0) {
    throw new Error("Selected text attachment collection cannot be empty");
  }
  const hasUserComment = attachments.some((attachment) => Boolean(attachment.comment?.trim()));

  return {
    type: "text",
    mimeType: "text/plain",
    title: "Selected text from the previous response",
    text: [
      ...(hasUserComment ? [] : [SELECTED_TEXT_CONTEXT]),
      ...attachments.flatMap((attachment, index) => [
        "<user_comments>",
        `<id>${index + 1}</id>`,
        "<selected_text>",
        escapeXmlText(attachment.text),
        "</selected_text>",
        "<comment>",
        escapeXmlText(attachment.comment?.trim() ?? ""),
        "</comment>",
        "</user_comments>",
      ]),
    ].join("\n"),
  };
}

export function getSelectedTextPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
