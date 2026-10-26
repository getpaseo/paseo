import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { QueuedAgentMessage } from "@getpaseo/protocol/messages";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import type { AttachmentPersister, DispatchComposerAgentMessageInput } from "@/composer/actions";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";

interface EnqueueComposerMessageInput {
  client: Pick<DaemonClient, "enqueueAgentMessage">;
  agentId: string;
  text: string;
  messageId: string;
  attachments: ComposerAttachment[];
  encodeImages: DispatchComposerAgentMessageInput["encodeImages"];
}

export async function enqueueComposerMessage(input: EnqueueComposerMessageInput): Promise<void> {
  const payload = splitComposerAttachmentsForSubmit(input.attachments);
  const images = await input.encodeImages(payload.images);
  await input.client.enqueueAgentMessage(input.agentId, input.text, {
    messageId: input.messageId,
    images: images ?? [],
    attachments: payload.attachments,
  });
}

interface RestoreQueuedMessageInput {
  message: QueuedAgentMessage;
  persister: Pick<AttachmentPersister, "persistFromDataUrl">;
}

export async function restoreQueuedMessageAttachments(
  input: RestoreQueuedMessageInput,
): Promise<UserComposerAttachment[]> {
  const attachments: UserComposerAttachment[] = input.message.attachments.map((attachment) => {
    if (attachment.type === "uploaded_file") return { kind: "file", attachment };
    return { kind: "context", attachment };
  });
  for (const image of input.message.images) {
    const metadata = await input.persister.persistFromDataUrl({
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      mimeType: image.mimeType,
      fileName: null,
    });
    attachments.push({ kind: "image", metadata });
  }
  return attachments;
}
