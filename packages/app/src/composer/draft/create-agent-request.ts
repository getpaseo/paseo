import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload, CreateAgentRequestMessage } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { encodeImages } from "@/utils/encode-images";
import type { UserMessageImageAttachment } from "@/types/stream";

export interface WorkspaceDraftAgentRequest {
  workspaceId: string;
  launchProfileId?: string;
  config: AgentSessionConfig;
  text: string;
  clientMessageId: string;
  images?: UserMessageImageAttachment[];
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
  const images = await encodeImages(request.images);
  const agent = await client.createAgent({
    config: request.config,
    workspaceId: request.workspaceId,
    ...(request.launchProfileId ? { launchProfileId: request.launchProfileId } : {}),
    idempotencyKey: `${request.clientMessageId}:agent`,
  });
  await client.sendMessage(agent.id, request.text, {
    messageId: request.clientMessageId,
    ...(images && images.length > 0 ? { images } : {}),
    ...(request.attachments && request.attachments.length > 0
      ? { attachments: request.attachments }
      : {}),
  });
  return agent;
}
