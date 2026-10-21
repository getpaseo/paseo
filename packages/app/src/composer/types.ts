import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
}

/**
 * Text the draft owner hands the editor. `hydrated` is the owner's answer to a mount:
 * the draft's text as persisted or still pending from the editor that unmounted.
 */
export interface TextReplacement {
  kind: "initial" | "hydrated" | "replace";
  key: string;
  text: string;
}
