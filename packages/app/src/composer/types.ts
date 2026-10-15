import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  /** Original composer text for non-prompt consumers; agent prompts use text. */
  rawText?: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
}

export interface TextReplacement {
  key: string;
  text: string;
}
