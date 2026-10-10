import type { PluginPendingAgentMessage } from "@getpaseo/plugin/client";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";
import { showDaemonSentAgentMessage, updateShownAgentMessage } from "@/composer/submission/writer";
import { createUserMessage } from "@/types/stream";

/**
 * Shows a plugin-created agent's first message until the daemon records it. The daemon's copy
 * carries text only, and reconciling keeps the images and files shown here.
 *
 * Text and files show at once. Images follow once stored, since storing can wait on attachment
 * garbage collection.
 */
export async function showPluginPendingAgentMessage(input: {
  serverId: string;
  agentId: string;
  message: PluginPendingAgentMessage;
}): Promise<void> {
  const { serverId, agentId, message } = input;
  const shown = createUserMessage({
    clientMessageId: message.clientMessageId,
    text: message.text,
    timestamp: new Date(),
    attachments: [...(message.attachments ?? [])],
  });
  showDaemonSentAgentMessage(serverId, agentId, shown);
  const images = await persistPendingImages(message.images ?? []);
  if (images.length > 0) {
    updateShownAgentMessage(serverId, agentId, createUserMessage({ ...shown, images }));
  }
}

/** An image that cannot be stored is left out; the message still shows. */
async function persistPendingImages(
  images: NonNullable<PluginPendingAgentMessage["images"]>,
): Promise<AttachmentMetadata[]> {
  const stored = await Promise.allSettled(
    images.map((image) =>
      persistAttachmentFromDataUrl({
        dataUrl: `data:${image.mimeType};base64,${image.data}`,
        mimeType: image.mimeType,
      }),
    ),
  );
  return stored.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}
