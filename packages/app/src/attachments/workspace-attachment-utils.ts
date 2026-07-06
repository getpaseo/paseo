import type {
  ComposerAttachment,
  PullRequestContextAttachment,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

export function isPullRequestContextAttachment(
  attachment: ComposerAttachment | undefined,
): attachment is PullRequestContextAttachment {
  return (
    attachment?.kind === "github.pull_request_comment" ||
    attachment?.kind === "github.pull_request_review" ||
    attachment?.kind === "github.pull_request_check"
  );
}

export function isWorkspaceAttachment(
  attachment: ComposerAttachment | undefined,
): attachment is WorkspaceComposerAttachment {
  return (
    attachment?.kind === "review" ||
    attachment?.kind === "browser_element" ||
    attachment?.kind === "chat_history" ||
    isPullRequestContextAttachment(attachment)
  );
}

export function userAttachmentsOnly(
  attachments: readonly ComposerAttachment[],
): UserComposerAttachment[] {
  return attachments.filter(
    (attachment): attachment is UserComposerAttachment =>
      attachment.kind !== "review" &&
      attachment.kind !== "browser_element" &&
      attachment.kind !== "chat_history" &&
      !isPullRequestContextAttachment(attachment),
  );
}

export function workspaceAttachmentToSubmitAttachment(
  attachment: ComposerAttachment,
): AgentAttachment | null {
  if (attachment.kind === "browser_element") {
    return {
      type: "text",
      mimeType: "text/plain",
      title: `Browser element · ${attachment.attachment.tag}`,
      text: attachment.attachment.formatted,
    };
  }
  if (isPullRequestContextAttachment(attachment)) {
    return {
      type: "text",
      mimeType: "text/plain",
      title: attachment.title,
      text: attachment.text,
    };
  }
  if (attachment.kind === "chat_history") {
    return attachment.attachment;
  }
  return attachment.kind === "review" ? attachment.attachment : null;
}
