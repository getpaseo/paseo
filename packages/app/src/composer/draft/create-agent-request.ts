import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload, CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { uploadImageAttachments } from "@/attachments/service";
import type { AttachmentMetadata } from "@/attachments/types";

export interface WorkspaceDraftAgentRequest {
  workspaceId: string;
  config: AgentSessionConfig;
  text: string;
  clientMessageId: string;
  images?: AttachmentMetadata[];
  attachments?: CreateAgentRequestMessage["attachments"];
}

/**
 * Shared by the workspace draft tab and by the new-workspace screen when it finishes creation
 * after the user has already navigated away and no draft tab will ever mount.
 */
export async function requestWorkspaceDraftAgent(
  client: DaemonClient,
  request: WorkspaceDraftAgentRequest,
): Promise<AgentSnapshotPayload> {
  const uploadedImageAttachments = await uploadImageAttachments({ client, images: request.images });
  const mergedAttachments = [...(request.attachments ?? []), ...(uploadedImageAttachments ?? [])];
  return await client.createAgent({
    config: request.config,
    workspaceId: request.workspaceId,
    clientMessageId: request.clientMessageId,
    ...(request.text ? { initialPrompt: request.text } : {}),
    ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
  });
}
