import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import {
  CircleDot,
  FileText,
  GitPullRequest,
  MessageSquareCode,
  MousePointer2,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import { getFileTypeLabel } from "@/attachments/file-types";
import { isPullRequestContextAttachment } from "@/attachments/workspace-attachment-utils";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export interface AttachmentPillContent {
  icon: ReactNode;
  title: string;
  subtitle: string;
}

function getReviewSubtitle(count: number, t: TFunction): string {
  return count === 1
    ? t("message.attachments.commentsOne")
    : t("message.attachments.commentsMany", { count });
}

function getPullRequestContextSubtitle(attachment: WorkspaceComposerAttachment): string {
  if (attachment.kind === "github.pull_request_check") {
    return "Check logs";
  }
  if (attachment.kind === "github.pull_request_comment") {
    return "Comment";
  }
  return "Review";
}

function getTextAttachmentSubtitle(
  attachment: Extract<AgentAttachment, { type: "text" }>,
  t: TFunction,
): string {
  if (attachment.contextKind === "chat_history") {
    return "Previous conversation";
  }
  return t("message.attachments.text");
}

export function getAgentAttachmentPillContent(
  attachment: AgentAttachment,
  t: TFunction,
): AttachmentPillContent {
  switch (attachment.type) {
    case "review":
      return {
        icon: attachmentReviewIcon,
        title: t("message.attachments.review"),
        subtitle: getReviewSubtitle(attachment.comments.length, t),
      };
    case "github_pr":
      return {
        icon: attachmentGithubPrIcon,
        title: attachment.title,
        subtitle: `PR #${attachment.number}`,
      };
    case "github_issue":
      return {
        icon: attachmentGithubIssueIcon,
        title: attachment.title,
        subtitle: `Issue #${attachment.number}`,
      };
    case "text":
      return {
        icon: attachmentFileIcon,
        title: attachment.title ?? t("message.attachments.textAttachment"),
        subtitle: getTextAttachmentSubtitle(attachment, t),
      };
    case "uploaded_file":
      return {
        icon: attachmentFileIcon,
        title: attachment.fileName,
        subtitle: getFileTypeLabel(attachment.fileName) ?? t("message.attachments.file"),
      };
  }
}

export function getWorkspaceAttachmentPillContent(
  attachment: WorkspaceComposerAttachment,
  t: TFunction,
): AttachmentPillContent {
  if (attachment.kind === "browser_element") {
    return {
      icon: attachmentBrowserIcon,
      title: attachment.attachment.tag,
      subtitle: t("composer.attachments.element"),
    };
  }
  if (isPullRequestContextAttachment(attachment)) {
    return {
      icon: attachmentFileIcon,
      title: attachment.title,
      subtitle: getPullRequestContextSubtitle(attachment),
    };
  }
  if (attachment.kind === "chat_history") {
    return {
      icon: attachmentFileIcon,
      title: attachment.attachment.title ?? t("message.attachments.textAttachment"),
      subtitle: getTextAttachmentSubtitle(attachment.attachment, t),
    };
  }
  return {
    icon: attachmentReviewIcon,
    title: t("message.attachments.review"),
    subtitle: getReviewSubtitle(attachment.commentCount, t),
  };
}

const ThemedAttachmentFileText = withUnistyles(FileText);
const ThemedAttachmentGitPullRequest = withUnistyles(GitPullRequest);
const ThemedAttachmentCircleDot = withUnistyles(CircleDot);
const ThemedAttachmentMessageSquareCode = withUnistyles(MessageSquareCode);
const ThemedAttachmentMousePointer = withUnistyles(MousePointer2);

const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const attachmentReviewIcon = (
  <ThemedAttachmentMessageSquareCode size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentGithubPrIcon = (
  <ThemedAttachmentGitPullRequest size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentGithubIssueIcon = (
  <ThemedAttachmentCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentFileIcon = (
  <ThemedAttachmentFileText size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
const attachmentBrowserIcon = (
  <ThemedAttachmentMousePointer size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
);
